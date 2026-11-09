/**
 * TauriVideoTab — Conversão de vídeo para formatos web-friendly (app desktop).
 *
 * Por entrada gera: MP4 (H.264 universal) + WebM (VP9, servido primeiro) +
 * poster JPG (fallback/LCP) — e AV1 opcional no preset av1-ultra.
 * Progresso real via `out_time_ms` do ffmpeg; corte em 6/8/10s pelos presets.
 */
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  VIDEO_PRESETS,
  buildPosterArgs,
  buildVideoArgs,
  buildVideoOutputName,
  type VideoKind,
  type VideoOutputKind,
  type VideoPreset,
} from "../lib/convert/presets";
import { checkVideo } from "../lib/convert/preflight";
import { calcSavedPct } from "../lib/convert/jobs";
import { formatBytes, makeId } from "./fileUtils";
import {
  basename,
  deleteFile,
  dirname,
  ensureOutputDir,
  fileExists,
  onWindowDragDrop,
  openFolder,
  pickVideoFiles,
  probeMedia,
  probeVideo,
  revealFile,
  runFfmpeg,
  uniquePath,
} from "../lib/infra/TauriFfmpeg";

type ItemStatus = "processando" | "pronto" | "erro";

type VideoOutFormat = VideoOutputKind | "jpg";

interface VideoOutput {
  format: VideoOutFormat;
  size: number;
  path: string;
  name: string;
}

interface VideoItem {
  id: string;
  path: string;
  name: string;
  sizeBytes: number;
  durationSec?: number;
  origWidth?: number;
  origHeight?: number;
  status: ItemStatus;
  progress: number;
  outputs: VideoOutput[];
  bigger: VideoOutFormat[];
  error?: string;
}

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv)$/i;
const POSTER_WIDTH = 1280;

/** Preset sintético: sem resize e sem corte — só converte/comprime. */
const ORIGINAL_VIDEO_PRESET: VideoPreset = {
  id: "original",
  label: "Original — sem resize/corte",
  width: null,
  fps: 30,
  crfMp4: 23,
  crfVp9: 28,
  durationCap: null,
  description: "Mantém dimensões e duração; só converte (MP4 + WebM + AV1 + poster) e comprime.",
  ffmpegMp4Args: ["-c:v", "libx264", "-crf", "23", "-preset", "medium"],
  ffmpegWebmArgs: ["-c:v", "libvpx-vp9", "-crf", "28", "-b:v", "0", "-deadline", "good", "-cpu-used", "2"],
  ffmpegAv1Args: ["-c:v", "libsvtav1", "-crf", "38", "-preset", "8"],
};

const ALL_VIDEO_PRESETS: VideoPreset[] = [ORIGINAL_VIDEO_PRESET, ...VIDEO_PRESETS];

function findVideoPreset(id: string): VideoPreset {
  const found = ALL_VIDEO_PRESETS.find((p) => p.id === id);
  if (!found) throw new Error(`Preset de vídeo desconhecido: "${id}"`);
  return found;
}

function formatDuration(sec: number | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  return `${Math.round(sec)}s`;
}

export function TauriVideoTab() {
  const [presetId, setPresetId] = useState<string>("original");
  const [items, setItems] = useState<VideoItem[]>([]);
  const [outDir, setOutDir] = useState<string>("");
  const [windowDragging, setWindowDragging] = useState<boolean>(false);
  const outDirRef = useRef<string | null>(null);
  const inputPicking = useRef(false);

  const preset: VideoPreset = findVideoPreset(presetId);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onWindowDragDrop({
      onDrop: (paths) => {
        void addPaths(paths);
      },
      onDragActive: (active) => setWindowDragging(active),
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  async function addPaths(paths: string[]): Promise<void> {
    const candidates = paths.filter((p) => VIDEO_EXT.test(p));
    if (candidates.length === 0) return;
    const fresh: VideoItem[] = [];
    for (const path of candidates) {
      const name = basename(path);
      try {
        const probe = await probeMedia(path);
        fresh.push({
          id: makeId(), path, name,
          sizeBytes: probe.sizeBytes,
          status: "processando", progress: 0,
          outputs: [], bigger: [],
        });
      } catch {
        fresh.push({
          id: makeId(), path, name, sizeBytes: 0,
          status: "erro", progress: 0,
          outputs: [], bigger: [],
          error: "Não foi possível ler o arquivo.",
        });
      }
    }
    setItems((prev) => [...prev, ...fresh]);
    for (const item of fresh) {
      if (item.status !== "processando") continue;
      await processItem(item, presetId);
    }
  }

  async function processItem(item: VideoItem, nextPresetId: string): Promise<void> {
    const effPreset = findVideoPreset(nextPresetId);
    const setProgress = (p: number) =>
      setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, progress: p } : it)));
    try {
      const vprobe = await probeVideo(item.path).catch(() => null);
      const durationSec = vprobe?.durationSec ?? effPreset.durationCap ?? 0;
      const width = vprobe?.width ?? 0;
      const height = vprobe?.height ?? 0;

      const errors = checkVideo({
        sizeBytes: item.sizeBytes,
        durationSec,
        name: item.name,
      }).filter((i) => i.level === "error");
      if (errors.length > 0) {
        setItems((prev) =>
          prev.map((it) =>
            it.id === item.id
              ? { ...it, status: "erro" as const, error: errors.map((e) => e.message).join(" ") }
              : it,
          ),
        );
        return;
      }

      if (!outDirRef.current) {
        outDirRef.current = await ensureOutputDir();
        setOutDir(outDirRef.current);
      }
      const dir = outDirRef.current;
      const outputs: VideoOutput[] = [];
      const bigger: VideoOutFormat[] = [];

      // Progresso relativo ao trecho cortado (preset corta em 6/8/10s, mas a
      // Duration do arquivo é integral — sem o ajuste a barra pararia em ~10%).
      const cap = effPreset.durationCap ?? durationSec;
      const scaleProgress = (p: number) =>
        setProgress(durationSec > 0 ? Math.min(1, (p * durationSec) / Math.max(cap, 1)) : p);

      const jobs: { format: VideoOutFormat; kind: VideoKind | "poster"; name: string; out: string; args: string[] }[] = [];
      for (const kind of ["mp4", "webm"] as const) {
        const base = buildVideoOutputName(item.name, effPreset.id, kind);
        const out = await uniquePath(dir, base);
        jobs.push({ format: kind, kind, name: basename(out), out, args: buildVideoArgs(item.path, out, effPreset, kind) });
      }
      {
        const base = buildVideoOutputName(item.name, effPreset.id, "poster");
        const out = await uniquePath(dir, base);
        const posterWidth = effPreset.width ?? width ?? POSTER_WIDTH;
        jobs.push({ format: "poster", kind: "poster", name: basename(out), out, args: buildPosterArgs(item.path, out, posterWidth > 0 ? posterWidth : POSTER_WIDTH) });
      }
      if (effPreset.ffmpegAv1Args) {
        const base = buildVideoOutputName(item.name, effPreset.id, "av1");
        const out = await uniquePath(dir, base);
        jobs.push({ format: "av1", kind: "av1", name: basename(out), out, args: buildVideoArgs(item.path, out, effPreset, "av1") });
      }

      for (const job of jobs) {
        const jobId = `${item.id}-${job.format}`;
        if (job.kind === "poster") {
          await runFfmpeg(job.args, jobId, setProgress);
        } else {
          await runFfmpeg(job.args, jobId, scaleProgress);
        }
        let outSize = 0;
        try {
          outSize = (await probeMedia(job.out)).sizeBytes;
        } catch {
          continue;
        }
        if (outSize >= item.sizeBytes && job.format !== "poster") {
          bigger.push(job.format);
          try {
            await deleteFile(job.out);
          } catch {
            /* saída descartada só da lista */
          }
          continue;
        }
        outputs.push({ format: job.format, size: outSize, path: job.out, name: job.name });
      }

      if (outputs.length === 0) {
        setItems((prev) =>
          prev.map((it) =>
            it.id === item.id
              ? {
                  ...it,
                  status: "erro" as const,
                  bigger: bigger as VideoOutFormat[],
                  error: "Saídas maiores que o original — o vídeo já está otimizado.",
                }
              : it,
          ),
        );
        return;
      }

      setItems((prev) =>
        prev.map((it) =>
          it.id === item.id
            ? {
                ...it,
                status: "pronto" as const,
                progress: 1,
                durationSec,
                origWidth: width || undefined,
                origHeight: height || undefined,
                outputs,
                bigger: bigger as VideoOutFormat[],
                error: undefined,
              }
            : it,
        ),
      );
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setItems((prev) =>
        prev.map((it) =>
          it.id === item.id
            ? { ...it, status: "erro" as const, error: `Falha no ffmpeg: ${detail}` }
            : it,
        ),
      );
    }
  }

  async function handleSelect(): Promise<void> {
    if (inputPicking.current) return;
    inputPicking.current = true;
    try {
      const paths = await pickVideoFiles();
      await addPaths(paths);
    } finally {
      inputPicking.current = false;
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void handleSelect();
    }
  }

  function reprocessAll(nextPresetId: string): void {
    const targets = items.filter((i) => i.status === "pronto");
    setPresetId(nextPresetId);
    if (targets.length === 0) return;
    const ids = new Set(targets.map((t) => t.id));
    setItems((prev) =>
      prev.map((it) =>
        ids.has(it.id)
          ? { ...it, status: "processando" as const, progress: 0, outputs: [], bigger: [], error: undefined }
          : it,
      ),
    );
    void (async () => {
      for (const t of targets) {
        for (const o of t.outputs) {
          try {
            if (await fileExists(o.path)) await deleteFile(o.path);
          } catch {
            /* segue sem a limpeza */
          }
        }
        await processItem(t, nextPresetId);
      }
    })();
  }

  function removeItem(id: string): void {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }

  function clearDone(): void {
    setItems((prev) => prev.filter((item) => item.status !== "pronto"));
  }

  const doneItems = items.filter((item) => item.status === "pronto");

  function formatTotals(format: VideoOutFormat): { before: number; after: number; saved: number; count: number } {
    const withFmt = doneItems.filter((item) => item.outputs.some((o) => o.format === format));
    const before = withFmt.reduce((acc, item) => acc + item.sizeBytes, 0);
    const after = withFmt.reduce(
      (acc, item) => acc + (item.outputs.find((o) => o.format === format)?.size ?? item.sizeBytes),
      0,
    );
    return {
      before,
      after,
      saved: before > 0 ? Math.max(0, calcSavedPct(before, after)) : 0,
      count: withFmt.length,
    };
  }

  const mp4Totals = formatTotals("mp4");
  const webmTotals = formatTotals("webm");
  const doneCount = doneItems.length;
  const processingCount = items.filter((item) => item.status === "processando").length;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
      {windowDragging && (
        <div
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          aria-hidden="true"
        >
          <div className="flex h-full w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed border-emerald-400 bg-emerald-500/10">
            <p className="text-lg font-medium text-white">Solte para adicionar à fila</p>
            <p className="mt-1 text-sm text-emerald-200">
              pode soltar em qualquer lugar da janela
            </p>
          </div>
        </div>
      )}
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <header>
          <h2 className="text-lg font-semibold text-white">Converter vídeo para web</h2>
          <p className="mt-1 text-sm text-zinc-500">
            MP4 + WebM + poster por arquivo, sem áudio.{" "}
            {preset.durationCap != null
              ? `Corte em ${preset.durationCap}s.`
              : "Original não corta nem redimensiona."}{" "}
            AV1 sai só no preset AV1 ultra.
          </p>
        </header>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" role="group" aria-label="Preset de vídeo">
          {ALL_VIDEO_PRESETS.map((p) => {
            const selected = presetId === p.id;
            const select = () => reprocessAll(p.id);
            return (
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`Preset ${p.label}`}
                onClick={select}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    select();
                  }
                }}
                className={`relative cursor-pointer rounded-xl border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
                  selected
                    ? "border-emerald-500 bg-emerald-500/10"
                    : "border-zinc-800 bg-zinc-900 hover:border-zinc-600"
                }`}
              >
                <span className="block text-sm font-semibold text-white">{p.label}</span>
                <span className="mt-1 block text-xs leading-relaxed text-zinc-400">{p.description}</span>
                <span className="mt-2 block text-xs font-medium text-emerald-300">
                  MP4 + WEBM + POSTER{p.ffmpegAv1Args ? " + AV1" : ""}
                </span>
              </div>
            );
          })}
        </div>

        <div
          role="button"
          tabIndex={0}
          aria-label="Adicionar vídeos: arraste arquivos para a janela ou pressione Enter para selecionar"
          onClick={() => void handleSelect()}
          onKeyDown={handleKeyDown}
          className="flex min-h-40 flex-col items-center justify-center rounded-2xl border-2 border-dashed border-zinc-700 bg-zinc-900/50 px-6 py-8 text-center transition hover:border-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
        >
          <p className="text-base font-medium text-white">Arraste vídeos aqui</p>
          <p className="mt-1 text-sm text-zinc-500">MP4 · MOV · WebM — ou pressione Enter</p>
          <span className="mt-4 inline-block rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-950">
            Selecionar vídeos
          </span>
        </div>

        <section aria-label="Vídeos para converter">
          {items.length === 0 ? (
            <p className="rounded-xl border border-zinc-800 px-4 py-10 text-center text-sm text-zinc-500">
              Fila vazia — solte vídeos na janela ou selecione acima.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-zinc-800">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
                    <th className="px-4 py-3 font-medium">Arquivo</th>
                    <th className="px-4 py-3 font-medium">Antes</th>
                    <th className="px-4 py-3 font-medium">Depois</th>
                    <th className="px-4 py-3 font-medium">Arquivos</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} className="border-b border-zinc-800/60 last:border-0">
                      <td className="max-w-56 px-4 py-3">
                        <span className="block truncate font-medium text-white" title={item.path}>
                          {item.name}
                        </span>
                        <span className="mt-0.5 block text-xs text-zinc-500">
                          {[item.origWidth && item.origHeight ? `${item.origWidth}×${item.origHeight}px` : null, formatDuration(item.durationSec)].filter(Boolean).join(" · ") || "—"}
                        </span>
                        {item.status === "erro" && item.error != null && (
                          <span className="mt-1 block text-xs leading-relaxed text-red-400">
                            {item.error}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-zinc-400">
                        {formatBytes(item.sizeBytes)}
                      </td>
                      <td className="px-4 py-3">
                        {item.status === "pronto" ? (
                          <span className="flex flex-col gap-1.5">
                            {item.outputs.map((o) => {
                              const s = Math.max(0, calcSavedPct(item.sizeBytes, o.size));
                              return (
                                <span key={o.format} className="flex flex-wrap items-center gap-2 whitespace-nowrap">
                                  <span className="w-14 text-[11px] font-semibold text-zinc-500">
                                    {o.format.toUpperCase()}
                                  </span>
                                  <span className="text-zinc-200">{formatBytes(o.size)}</span>
                                  <span
                                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                                      s >= 30
                                        ? "bg-emerald-500/20 text-emerald-300"
                                        : "bg-amber-500/20 text-amber-300"
                                    }`}
                                  >
                                    −{s.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
                                  </span>
                                </span>
                              );
                            })}
                            {item.bigger
                              .filter((f) => f !== "poster")
                              .map((f) => (
                                <span key={f} className="text-xs text-zinc-600">
                                  {f.toUpperCase()} — ficou maior que o original, descartado
                                </span>
                              ))}
                          </span>
                        ) : item.status === "processando" ? (
                          <span className="text-zinc-500">
                            convertendo… {Math.round(item.progress * 100)}%
                          </span>
                        ) : (
                          <span className="text-zinc-600">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {item.status === "pronto" ? (
                          <span className="flex flex-wrap gap-x-3 gap-y-1">
                            {item.outputs.map((o) => (
                              <button
                                key={o.format}
                                type="button"
                                onClick={() => void revealFile(o.path, dirname(o.path))}
                                title={o.path}
                                className="text-xs font-medium text-emerald-300 transition hover:text-emerald-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                              >
                                {o.format.toUpperCase()}
                              </button>
                            ))}
                          </span>
                        ) : (
                          <span className="text-zinc-600">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded-full px-2.5 py-0.5 text-xs ${
                            item.status === "pronto"
                              ? "bg-emerald-500/20 text-emerald-300"
                              : item.status === "processando"
                                ? "animate-pulse bg-amber-500/20 text-amber-300"
                                : "bg-red-500/20 text-red-300"
                          }`}
                        >
                          {item.status}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => removeItem(item.id)}
                          aria-label={`Remover ${item.name}`}
                          className="text-xs text-zinc-600 transition hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                        >
                          remover
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {items.length > 0 && (
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 pt-4">
            <p className="text-sm text-zinc-400">
              {mp4Totals.count > 0 && (
                <span className="mr-4">
                  MP4: <span className="text-zinc-200">{formatBytes(mp4Totals.before)}</span>{" "}
                  → <span className="text-zinc-200">{formatBytes(mp4Totals.after)}</span>{" "}
                  <span className="font-medium text-emerald-300">
                    (−{mp4Totals.saved.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%)
                  </span>
                </span>
              )}
              {webmTotals.count > 0 && (
                <span className="mr-4">
                  WebM: <span className="text-zinc-200">{formatBytes(webmTotals.before)}</span>{" "}
                  → <span className="text-zinc-200">{formatBytes(webmTotals.after)}</span>{" "}
                  <span className="font-medium text-emerald-300">
                    (−{webmTotals.saved.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%)
                  </span>
                </span>
              )}
              {doneCount === 0 && <span>Nenhum concluído ainda.</span>}
              {processingCount > 0 && (
                <span className="ml-2 text-amber-300">· {processingCount} convertendo…</span>
              )}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => outDir && void openFolder(outDir)}
                disabled={!outDir}
                title="Abrir a pasta com os arquivos gerados"
                className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Abrir pasta de saída
              </button>
              <button
                type="button"
                onClick={clearDone}
                disabled={doneCount === 0}
                className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Limpar concluídos
              </button>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
