/**
 * TauriConvertTab — Conversão/compressão com o ffmpeg REAL (app desktop).
 *
 * Intake por PATHS reais (drag na janela ou diálogo nativo), saída na mesma
 * pasta do original com nome slugificado. WebP/JPG via libwebp/mjpeg, AVIF
 * via libaom-av1 (nível Cloudinary), resize sem upscale via filtro scale.
 */
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import {
  IMAGE_PRESETS,
  buildAvifencArgs,
  buildImageFfmpegArgs,
  type ImageFormat,
} from "../lib/convert/presets";
import { checkImage } from "../lib/convert/preflight";
import { calcSavedPct } from "../lib/convert/jobs";
import { buildOutputName } from "../lib/convert/slugify";
import { CONVERT_PRESETS, findPreset } from "./ConverterTab";
import { formatBytes, loadImageElement, makeId } from "./fileUtils";
import {
  DEFAULT_CLIENT,
  getActiveClientId,
  loadClients,
  makeClient,
  saveClients,
  setActiveClientId as persistActiveClientId,
  type ClientPreset,
} from "../lib/convert/clients";
import {
  basename,
  convertFileSrc,
  deleteFile,
  dirname,
  ensureOutputDir,
  fileExists,
  onWindowDragDrop,
  openFolder,
  pickImageFiles,
  probeMedia,
  revealFile,
  runAvifenc,
  runFfmpeg,
  uniquePath,
} from "../lib/infra/TauriFfmpeg";

type TabKind = "convert" | "compress";
type CompressMode = "jpg" | "png";
type ItemStatus = "processando" | "pronto" | "erro";

interface TauriOutput {
  format: ImageFormat;
  size: number;
  path: string;
  name: string;
}

interface TauriItem {
  id: string;
  path: string;
  name: string;
  sizeBytes: number;
  origWidth?: number;
  origHeight?: number;
  outWidth?: number;
  outHeight?: number;
  status: ItemStatus;
  progress: number;
  outputs: TauriOutput[];
  biggerFormats: ImageFormat[];
  avifSkipped: boolean;
  /** true quando o AVIF foi pulado porque a imagem tem transparência. */
  avifAlphaSkipped: boolean;
  error?: string;
}

const MIN_QUALITY = 50;
const MAX_QUALITY = 95;
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

const COMPRESS_JPG = IMAGE_PRESETS.find((p) => p.id === "compress-jpg");
const COMPRESS_PNG = IMAGE_PRESETS.find((p) => p.id === "compress-png");

function GearIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function TauriConvertTab({ kind }: { kind: TabKind }) {
  const [presetId, setPresetId] = useState<string>("original");
  const [compressMode, setCompressMode] = useState<CompressMode>("jpg");
  const [clients, setClients] = useState<ClientPreset[]>(() => loadClients());
  const [activeClientId, setActiveClientId] = useState<string>(() => {
    const stored = getActiveClientId();
    return loadClients().some((c) => c.id === stored) ? stored : DEFAULT_CLIENT.id;
  });
  const activeClient = clients.find((c) => c.id === activeClientId) ?? DEFAULT_CLIENT;
  const [quality, setQuality] = useState<number>(() =>
    kind === "compress" ? activeClient.jpgQuality : activeClient.webpQuality,
  );
  const [avifQuality, setAvifQuality] = useState<number>(() => activeClient.avifQuality);
  const [showQuality, setShowQuality] = useState<boolean>(false);
  const [windowDragging, setWindowDragging] = useState<boolean>(false);
  const [clientFormOpen, setClientFormOpen] = useState<boolean>(false);
  const [newClientName, setNewClientName] = useState<string>("");
  const [items, setItems] = useState<TauriItem[]>([]);
  const [outDir, setOutDir] = useState<string>("");
  const outDirRef = useRef<string | null>(null);
  const inputPicking = useRef(false);

  // Drop na janela entrega paths reais do SO.
  // NOTE: `onWindowDrop` é assíncrono — sem o flag `cancelled`, o cleanup do
  // StrictMode (remount em dev) roda antes do `.then` e o 1º listener nunca é
  // removido, duplicando cada drop. Foi exatamente esse bug (4 imgs → 8 itens).
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

  async function dimsOf(path: string): Promise<{ w: number; h: number } | null> {
    try {
      const img = await loadImageElement(convertFileSrc(path));
      return { w: img.naturalWidth, h: img.naturalHeight };
    } catch {
      return null;
    }
  }

  async function addPaths(paths: string[]): Promise<void> {
    const candidates = paths.filter((p) => IMAGE_EXT.test(p));
    if (kind === "compress") {
      // compress só aceita jpg/png
      const ok = candidates.filter((p) => /\.(jpe?g|png)$/i.test(p));
      if (ok.length === 0) return;
      await enqueue(ok);
      return;
    }
    if (candidates.length === 0) return;
    await enqueue(candidates);
  }

  async function enqueue(paths: string[]): Promise<void> {
    const fresh: TauriItem[] = [];
    for (const path of paths) {
      const name = basename(path);
      let sizeBytes = 0;
      try {
        const probe = await probeMedia(path);
        sizeBytes = probe.sizeBytes;
      } catch {
        fresh.push({
          id: makeId(), path, name, sizeBytes: 0, status: "erro", progress: 0,
          outputs: [], biggerFormats: [], avifSkipped: false, avifAlphaSkipped: false,
          error: "Não foi possível ler o arquivo.",
        });
        continue;
      }
      fresh.push({
        id: makeId(), path, name, sizeBytes, status: "processando", progress: 0,
        outputs: [], biggerFormats: [], avifSkipped: false, avifAlphaSkipped: false,
      });
    }
    setItems((prev) => [...prev, ...fresh]);
    for (const item of fresh) {
      if (item.status !== "processando") continue;
      await processItem(item);
    }
  }

  interface ProcessOverrides {
    presetId?: string;
    quality?: number;
    avifQuality?: number;
    mode?: CompressMode;
  }

  async function processItem(item: TauriItem, overrides?: ProcessOverrides): Promise<void> {
    const effPresetId = overrides?.presetId ?? presetId;
    const effQuality = overrides?.quality ?? quality;
    const effAvifQuality = overrides?.avifQuality ?? avifQuality;
    const effMode = overrides?.mode ?? compressMode;
    const effPreset = kind === "convert" ? findPreset(effPresetId) : undefined;
    const setProgress = (p: number) =>
      setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, progress: p } : it)));
    try {
      const dims = await dimsOf(item.path);
      const targetWidth = kind === "convert" ? (effPreset?.width ?? null) : null;
      // BAD_FILENAME não bloqueia: a saída já sai slugificada.
      const issues = checkImage({
        sizeBytes: item.sizeBytes,
        width: dims?.w ?? 1,
        targetWidth,
        alt: item.name,
        name: item.name,
        isCompress: kind === "compress",
      }).filter((i) => i.code !== "BAD_FILENAME" && !(dims == null && i.code === "INVALID_WIDTH"));
      const errors = issues.filter((i) => i.level === "error");
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
      const outputs: TauriOutput[] = [];
      const bigger: ImageFormat[] = [];

      type JobRunner = "ffmpeg" | "avifenc";
      const jobs: { format: ImageFormat; args: string[]; name: string; out: string; runner: JobRunner }[] = [];
      // Nomes únicos: se `foto-1200w.webp` já existe, sai `foto-1200w-2.webp`.
      // Nunca sobrescreve silenciosamente.
      if (kind === "convert" && effPreset) {
        for (const format of effPreset.formats) {
          const base = buildOutputName(item.name, effPreset.id, effPreset.width, format);
          const out = await uniquePath(dir, base);
          const name = basename(out);
          if (format === "webp") {
            jobs.push({ format, name, out, runner: "ffmpeg", args: buildImageFfmpegArgs(item.path, out, effPreset.width, "webp", effQuality) });
          } else if (format === "jpg") {
            jobs.push({ format, name, out, runner: "ffmpeg", args: buildImageFfmpegArgs(item.path, out, effPreset.width, "jpg", effPreset.jpegQuality ?? 82) });
          } else {
            // AVIF sempre via avifenc (libavif): preserva alpha, nível Cloudinary.
            jobs.push({ format, name, out, runner: "avifenc", args: buildAvifencArgs(item.path, out, effAvifQuality) });
          }
        }
      } else {
        const ext = effMode === "jpg" ? "jpg" : "png";
        const base = buildOutputName(item.name, "comprimido", null, ext);
        const out = await uniquePath(dir, base);
        jobs.push({
          format: ext, name: basename(out), out, runner: "ffmpeg",
          args: buildImageFfmpegArgs(item.path, out, null, ext, ext === "jpg" ? effQuality : 100),
        });
      }

      for (const job of jobs) {
        const jobId = `${item.id}-${job.format}`;
        if (job.runner === "avifenc") {
          await runAvifenc(job.args, jobId, setProgress);
        } else {
          await runFfmpeg(job.args, jobId, setProgress);
        }
        const outPath = job.out;
        let outSize = 0;
        try {
          outSize = (await probeMedia(outPath)).sizeBytes;
        } catch {
          continue;
        }
        if (outSize >= item.sizeBytes) {
          bigger.push(job.format);
          try {
            await deleteFile(outPath);
          } catch {
            /* saída descartada só da lista */
          }
          // Stream: avisa o descarte na hora, sem esperar os demais formatos.
          const biggerNow = [...bigger];
          setItems((prev) =>
            prev.map((it) => (it.id === item.id ? { ...it, biggerFormats: biggerNow } : it)),
          );
          continue;
        }
        outputs.push({ format: job.format, size: outSize, path: outPath, name: job.name });
        // Stream: cada formato concluído aparece na tabela imediatamente —
        // o AVIF (lento) não segura o WebP (rápido).
        const outputsNow = [...outputs];
        setItems((prev) =>
          prev.map((it) => (it.id === item.id ? { ...it, outputs: outputsNow } : it)),
        );
      }

      if (outputs.length === 0) {
        setItems((prev) =>
          prev.map((it) =>
            it.id === item.id
              ? {
                  ...it,
                  status: "erro" as const,
                  biggerFormats: bigger,
                  avifSkipped: false,
                  avifAlphaSkipped: false,
                  error:
                    "Saída ficou maior que o original — o arquivo já está otimizado, mantenha como está.",
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
                origWidth: dims?.w,
                origHeight: dims?.h,
                outWidth: dims?.w,
                outHeight: dims?.h,
                outputs,
                biggerFormats: bigger,
                avifSkipped: false,
                avifAlphaSkipped: false,
                error: undefined,
              }
            : it,
        ),
      );
    } catch (e) {
      // Mostra a mensagem REAL (Rust/sidecar/permissão) em vez de genérica.
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
      const paths = await pickImageFiles(kind === "convert");
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

  /** Troca preset/qualidades/modo e reconverte só as prontas (com os NOVOS valores). */
  function reprocessAll(nextPresetId: string, nextQuality: number, nextAvifQuality: number, nextMode: CompressMode): void {
    const targets = items.filter((i) => i.status === "pronto");
    if (kind === "convert") setPresetId(nextPresetId);
    else setCompressMode(nextMode);
    setQuality(nextQuality);
    setAvifQuality(nextAvifQuality);
    if (targets.length === 0) return;
    const ids = new Set(targets.map((t) => t.id));
    setItems((prev) =>
      prev.map((it) =>
        ids.has(it.id)
          ? { ...it, status: "processando" as const, progress: 0, outputs: [], biggerFormats: [], avifSkipped: false, avifAlphaSkipped: false, error: undefined }
          : it,
      ),
    );
    const overrides = { presetId: nextPresetId, quality: nextQuality, avifQuality: nextAvifQuality, mode: nextMode };
    void (async () => {
      for (const t of targets) {
        // Apaga as saídas anteriores: reconverter com outra qualidade
        // regenera os MESMOS nomes em vez de empilhar -2, -3…
        for (const o of t.outputs) {
          try {
            if (await fileExists(o.path)) await deleteFile(o.path);
          } catch {
            /* segue sem a limpeza */
          }
        }
        await processItem(t, overrides);
      }
    })();
  }

  /** Troca de cliente: aplica as qualidades salvas e reconverte as prontas. */
  function applyClient(id: string): void {
    const c = clients.find((x) => x.id === id) ?? DEFAULT_CLIENT;
    persistActiveClientId(id);
    setActiveClientId(id);
    const webpQ = kind === "compress" ? c.jpgQuality : c.webpQuality;
    setQuality(webpQ);
    setAvifQuality(c.avifQuality);
    reprocessAll(presetId, webpQ, c.avifQuality, compressMode);
  }

  /** Salva os sliders atuais como um novo cliente. */
  function saveCurrentAsClient(): void {
    const name = newClientName.trim();
    if (!name) return;
    const c = makeClient(name, {
      webpQuality: kind === "convert" ? quality : activeClient.webpQuality,
      avifQuality,
      jpgQuality: kind === "compress" ? quality : activeClient.jpgQuality,
    });
    const next = [...clients, c];
    setClients(next);
    saveClients(next);
    setNewClientName("");
    setClientFormOpen(false);
    applyClient(c.id);
  }

  function deleteClient(id: string): void {
    if (id === DEFAULT_CLIENT.id) return;
    const next = clients.filter((c) => c.id !== id);
    setClients(next);
    saveClients(next);
    if (activeClientId === id) applyClient(DEFAULT_CLIENT.id);
  }

  function removeItem(id: string): void {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }

  function clearDone(): void {
    setItems((prev) => prev.filter((item) => item.status !== "pronto"));
  }

  const doneItems = items.filter((item) => item.status === "pronto");

  /** Totais por formato: antes (soma dos originais) → depois (soma das saídas). */
  function formatTotals(format: ImageFormat): { before: number; after: number; saved: number; count: number } {
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

  const webpTotals = formatTotals("webp");
  const avifTotals = formatTotals("avif");
  const doneCount = items.filter((item) => item.status === "pronto").length;
  const processingCount = items.filter((item) => item.status === "processando").length;

  const isConvert = kind === "convert";
  const title = isConvert ? "Converter para web" : "Comprimir imagens";
  const subtitle = isConvert
    ? "ffmpeg real: resize opcional + WebP/AVIF (libaom). Saída em Imagens/Otimizadas."
    : "ffmpeg real: mesmo formato e dimensões, só o peso cai. Saída em Imagens/Otimizadas.";

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
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>
        </header>

        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="client-select" className="text-sm text-zinc-400">
            Cliente:
          </label>
          <select
            id="client-select"
            value={activeClientId}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => applyClient(e.target.value)}
            className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — WebP {c.webpQuality} · AVIF {c.avifQuality} · JPG {c.jpgQuality}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setClientFormOpen((v) => !v)}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            ＋ Novo
          </button>
          {activeClientId !== DEFAULT_CLIENT.id && (
            <button
              type="button"
              onClick={() => deleteClient(activeClientId)}
              title={`Excluir cliente ${activeClient.name}`}
              className="rounded-lg border border-zinc-800 px-3 py-1.5 text-sm text-zinc-500 transition hover:border-red-500 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              Excluir
            </button>
          )}
        </div>

        {clientFormOpen && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 p-3">
            <input
              type="text"
              value={newClientName}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setNewClientName(e.target.value)}
              placeholder="Nome do cliente (ex.: Padaria Pão Dourado)"
              maxLength={40}
              className="min-w-52 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-white placeholder:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            />
            <span className="text-xs text-zinc-500">
              usa as qualidades atuais: WebP {quality} · AVIF {avifQuality} · JPG{" "}
              {kind === "compress" ? quality : activeClient.jpgQuality}
            </span>
            <button
              type="button"
              onClick={saveCurrentAsClient}
              disabled={!newClientName.trim()}
              className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Salvar
            </button>
          </div>
        )}

        {isConvert ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" role="group" aria-label="Preset de conversão">
            {CONVERT_PRESETS.map((p) => {
              const selected = presetId === p.id;
              const select = () =>
                reprocessAll(p.id, p.webpQuality ?? quality, p.avifQuality ?? avifQuality, compressMode);
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
                  <span className="block pr-8 text-sm font-semibold text-white">{p.label}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-zinc-400">{p.description}</span>
                  <span className="mt-2 block text-xs font-medium text-emerald-300">
                    {p.formats.join(" + ").toUpperCase()}
                  </span>
                  <button
                    type="button"
                    aria-label={`Ajustes de qualidade: ${p.label}`}
                    aria-expanded={selected && showQuality}
                    title="Ajustes de qualidade"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!selected) {
                        select();
                        setShowQuality(true);
                      } else {
                        setShowQuality((v) => !v);
                      }
                    }}
                    className="absolute right-2 top-2 rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                  >
                    <GearIcon />
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2" role="group" aria-label="Modo de compressão">
            {(["jpg", "png"] as const).map((m) => {
              const p = m === "jpg" ? COMPRESS_JPG : COMPRESS_PNG;
              const selected = compressMode === m;
              const select = () => reprocessAll(presetId, quality, avifQuality, m);
              return (
                <div
                  key={m}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  aria-label={`Comprimir ${m.toUpperCase()}`}
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
                  <span className="block pr-8 text-sm font-semibold text-white">
                    Comprimir {m.toUpperCase()}
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-zinc-400">
                    {p?.description ?? ""}
                  </span>
                  {m === "jpg" && (
                    <button
                      type="button"
                      aria-label="Ajustes de qualidade: Comprimir JPG"
                      aria-expanded={selected && showQuality}
                      title="Ajustes de qualidade"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!selected) {
                          select();
                          setShowQuality(true);
                        } else {
                          setShowQuality((v) => !v);
                        }
                      }}
                      className="absolute right-2 top-2 rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                    >
                      <GearIcon />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {showQuality && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-zinc-400">
                Qualidade — {isConvert ? findPreset(presetId).label : `Comprimir ${compressMode.toUpperCase()}`}
              </p>
              <button
                type="button"
                onClick={() => setShowQuality(false)}
                className="text-xs text-zinc-500 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              >
                fechar
              </button>
            </div>
            {(isConvert || compressMode === "jpg") && (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
                <label htmlFor="tauri-quality" className="text-sm font-medium text-zinc-200">
                  Qualidade {isConvert ? "WebP" : "JPG"}: <span className="text-white">{quality}</span>
                </label>
                <input
                  id="tauri-quality"
                  type="range"
                  min={MIN_QUALITY}
                  max={MAX_QUALITY}
                  step={1}
                  value={quality}
                  onChange={(e) => reprocessAll(presetId, Number(e.target.value), avifQuality, compressMode)}
                  className="mt-2 w-full accent-emerald-400"
                />
                <p className="mt-1 text-xs text-zinc-500">
                  Trocar o valor reconverte a lista. JPG fallback do preset 1200w sai em q82 fixo.
                </p>
              </div>
            )}
            {isConvert && (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
                <label htmlFor="tauri-avif-quality" className="text-sm font-medium text-zinc-200">
                  Qualidade AVIF: <span className="text-white">{avifQuality}</span>
                </label>
                <input
                  id="tauri-avif-quality"
                  type="range"
                  min={MIN_QUALITY}
                  max={MAX_QUALITY}
                  step={1}
                  value={avifQuality}
                  onChange={(e) => reprocessAll(presetId, quality, Number(e.target.value), compressMode)}
                  className="mt-2 w-full accent-emerald-400"
                />
                <p className="mt-1 text-xs text-zinc-500">
                  60 = menor arquivo · 65 = equilíbrio (padrão) · 85+ = arquivístico, raramente vale.
                </p>
              </div>
            )}
          </div>
        )}

        <div
          role="button"
          tabIndex={0}
          aria-label="Adicionar imagens: arraste arquivos para a janela ou pressione Enter para selecionar"
          onClick={() => void handleSelect()}
          onKeyDown={handleKeyDown}
          className="flex min-h-40 flex-col items-center justify-center rounded-2xl border-2 border-dashed border-zinc-700 bg-zinc-900/50 px-6 py-8 text-center transition hover:border-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
        >
          <p className="text-base font-medium text-white">Arraste imagens para a janela</p>
          <p className="mt-1 text-sm text-zinc-500">ou pressione Enter para selecionar (diálogo nativo)</p>
          <span className="mt-4 inline-block rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-950">
            Selecionar imagens
          </span>
        </div>

        <section aria-label={title}>
          {items.length === 0 ? (
            <p className="rounded-xl border border-zinc-800 px-4 py-10 text-center text-sm text-zinc-500">
              Fila vazia — arraste arquivos para a janela ou selecione acima.
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
                        {item.origWidth != null && item.origHeight != null && (
                          <span className="mt-0.5 block text-xs text-zinc-500">
                            {item.origWidth}×{item.origHeight}px
                          </span>
                        )}
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
                        <span className="flex flex-col gap-1.5">
                          {item.status === "processando" && (
                            <span className="text-xs text-amber-300">
                              convertendo… {Math.round(item.progress * 100)}%
                            </span>
                          )}
                          {item.outputs
                            .filter((o) => o.format !== "jpg")
                            .map((o) => {
                              const s = Math.max(0, calcSavedPct(item.sizeBytes, o.size));
                              return (
                                <span key={o.format} className="flex flex-wrap items-center gap-2 whitespace-nowrap">
                                  <span className="w-10 text-[11px] font-semibold text-zinc-500">
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
                          {item.biggerFormats
                            .filter((f) => f !== "jpg")
                            .map((f) => (
                              <span key={f} className="text-xs text-zinc-600">
                                {f.toUpperCase()} — ficou maior que o original, descartado
                              </span>
                            ))}
                          {item.avifSkipped && (
                            <span className="text-xs text-zinc-600">
                              AVIF indisponível neste arquivo
                            </span>
                          )}
                          {item.outputs.length === 0 &&
                            item.biggerFormats.length === 0 &&
                            !item.avifSkipped &&
                            item.status !== "processando" && (
                              <span className="text-zinc-600">—</span>
                            )}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {item.outputs.length > 0 ? (
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
              {webpTotals.count > 0 && (
                <span className="mr-4">
                  WebP: <span className="text-zinc-200">{formatBytes(webpTotals.before)}</span>{" "}
                  → <span className="text-zinc-200">{formatBytes(webpTotals.after)}</span>{" "}
                  <span className="font-medium text-emerald-300">
                    (−{webpTotals.saved.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%)
                  </span>
                </span>
              )}
              {avifTotals.count > 0 && (
                <span className="mr-4">
                  AVIF: <span className="text-zinc-200">{formatBytes(avifTotals.before)}</span>{" "}
                  → <span className="text-zinc-200">{formatBytes(avifTotals.after)}</span>{" "}
                  <span className="font-medium text-emerald-300">
                    (−{avifTotals.saved.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%)
                  </span>
                </span>
              )}
              {doneItems.length === 0 && <span>Nenhum concluído ainda.</span>}
              {processingCount > 0 && (
                <span className="ml-2 text-amber-300">· {processingCount} processando…</span>
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
