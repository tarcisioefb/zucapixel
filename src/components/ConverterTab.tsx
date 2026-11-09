import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, KeyboardEvent } from "react";
import {
  IMAGE_PRESETS,
  getImagePreset,
  type ImageFormat,
  type ImagePreset,
} from "../lib/convert/presets";
import { checkImage } from "../lib/convert/preflight";
import { calcSavedPct } from "../lib/convert/jobs";
import { buildOutputName } from "../lib/convert/slugify";
import {
  canvasToBlob,
  downloadBlob,
  formatBytes,
  loadImageElement,
  makeId,
  supportsAvifEncode,
} from "./fileUtils";

/** Presets de conversão (resize). Exclui compress-only e logo-lossless. */
const CONVERT_PRESETS: ImagePreset[] = IMAGE_PRESETS.filter(
  (p) => !p.compressOnly && !p.lossless && p.width != null,
);

const ACCEPT = "image/jpeg,image/png,image/webp";
const MIN_QUALITY = 50;
const MAX_QUALITY = 95;

type ConvertStatus = "processando" | "pronto" | "erro";

interface ConvertOutput {
  format: ImageFormat;
  size: number;
  url: string;
  name: string;
}

interface ConvertItem {
  id: string;
  name: string;
  sizeBytes: number;
  origWidth?: number;
  origHeight?: number;
  outWidth?: number;
  outHeight?: number;
  status: ConvertStatus;
  file: File;
  outputs: ConvertOutput[];
  avifSkipped: boolean;
  error?: string;
}

/** Redimensiona (sem upscale) + encodes nos formatos do preset. Roda no canvas. */
async function convertImage(
  file: File,
  preset: ImagePreset,
  webpQuality: number,
  avifOk: boolean,
): Promise<{ outputs: ConvertOutput[]; avifSkipped: boolean; width: number; height: number }> {
  const targetWidth = preset.width ?? 0;
  const src = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(src);
    const naturalWidth = img.naturalWidth;
    const naturalHeight = img.naturalHeight;
    const scale = targetWidth > 0 ? Math.min(1, targetWidth / naturalWidth) : 1;
    const outWidth = Math.max(1, Math.round(naturalWidth * scale));
    const outHeight = Math.max(1, Math.round(naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = outWidth;
    canvas.height = outHeight;

    const outputs: ConvertOutput[] = [];
    let avifSkipped = false;

    for (const format of preset.formats) {
      if (format === "avif" && !avifOk) {
        avifSkipped = true;
        continue;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas");
      ctx.clearRect(0, 0, outWidth, outHeight);
      if (format === "jpg") {
        // JPEG não tem alpha: fundo branco senão vira preto.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, outWidth, outHeight);
      }
      ctx.drawImage(img, 0, 0, outWidth, outHeight);

      let blob: Blob;
      if (format === "webp") {
        blob = await canvasToBlob(canvas, "image/webp", webpQuality / 100);
      } else if (format === "jpg") {
        const q = (preset.jpegQuality ?? 82) / 100;
        blob = await canvasToBlob(canvas, "image/jpeg", q);
      } else {
        const q = (preset.avifQuality ?? 60) / 100;
        blob = await canvasToBlob(canvas, "image/avif", q);
      }
      const name = buildOutputName(file.name, preset.id, targetWidth, format);
      outputs.push({ format, size: blob.size, url: URL.createObjectURL(blob), name });
    }
    return { outputs, avifSkipped, width: outWidth, height: outHeight };
  } finally {
    URL.revokeObjectURL(src);
  }
}

export function ConverterTab() {
  const [presetId, setPresetId] = useState<string>(CONVERT_PRESETS[0]?.id ?? "1200w");
  const [quality, setQuality] = useState<number>(
    CONVERT_PRESETS[0]?.webpQuality ?? 80,
  );
  const [items, setItems] = useState<ConvertItem[]>([]);
  const [dragging, setDragging] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const urlsRef = useRef<string[]>([]);

  const preset = getImagePreset(presetId);

  useEffect(() => {
    const bag = urlsRef.current;
    return () => {
      bag.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  function trackUrls(urls: string[]): void {
    urlsRef.current.push(...urls);
  }

  function untrackUrls(urls: string[]): void {
    urls.forEach((url) => URL.revokeObjectURL(url));
    urlsRef.current = urlsRef.current.filter((u) => !urls.includes(u));
  }

  async function runOne(
    id: string,
    file: File,
    origName: string,
    origSize: number,
    nextPreset: ImagePreset,
    nextQuality: number,
  ): Promise<void> {
    try {
      const avifOk = nextPreset.formats.includes("avif") ? await supportsAvifEncode() : false;
      const { outputs, avifSkipped, width, height } = await convertImage(
        file,
        nextPreset,
        nextQuality,
        avifOk,
      );
      // BAD_FILENAME não bloqueia: o nome de saída já sai slugificado.
      const issues = checkImage({
        sizeBytes: origSize,
        width,
        targetWidth: nextPreset.width,
        alt: origName,
        name: origName,
      }).filter((issue) => issue.code !== "BAD_FILENAME");
      const errors = issues.filter((issue) => issue.level === "error");
      if (errors.length > 0) {
        outputs.forEach((o) => URL.revokeObjectURL(o.url));
        setItems((prev) =>
          prev.map((item) =>
            item.id === id
              ? {
                  ...item,
                  status: "erro" as const,
                  error: errors.map((e) => e.message).join(" "),
                }
              : item,
          ),
        );
        return;
      }
      trackUrls(outputs.map((o) => o.url));
      setItems((prev) =>
        prev.map((item) => {
          if (item.id !== id) return item;
          untrackUrls(item.outputs.map((o) => o.url));
          return {
            ...item,
            status: "pronto" as const,
            outWidth: width,
            outHeight: height,
            outputs,
            avifSkipped,
            error: undefined,
          };
        }),
      );
    } catch {
      setItems((prev) =>
        prev.map((item) =>
          item.id === id
            ? { ...item, status: "erro" as const, error: "Falha ao converter no navegador." }
            : item,
        ),
      );
    }
  }

  function addFiles(files: File[]): void {
    if (files.length === 0) return;
    const fresh: ConvertItem[] = files.map((file) => {
      const okType =
        file.type.startsWith("image/") || /\.(jpe?g|png|webp)$/i.test(file.name);
      if (!okType) {
        return {
          id: makeId(),
          name: file.name,
          sizeBytes: file.size,
          status: "erro" as const,
          file,
          outputs: [],
          avifSkipped: false,
          error: "Tipo não suportado — envie JPG, PNG ou WebP.",
        };
      }
      return {
        id: makeId(),
        name: file.name,
        sizeBytes: file.size,
        status: "processando" as const,
        file,
        outputs: [],
        avifSkipped: false,
      };
    });
    setItems((prev) => [...prev, ...fresh]);
    void (async () => {
      for (const item of fresh) {
        if (item.status !== "processando") continue;
        await runOne(item.id, item.file, item.name, item.sizeBytes, preset, quality);
      }
    })();
  }

  function reprocess(
    targets: ConvertItem[],
    nextPreset: ImagePreset,
    nextQuality: number,
  ): void {
    if (targets.length === 0) return;
    const ids = new Set(targets.map((t) => t.id));
    setItems((prev) =>
      prev.map((item) => {
        if (!ids.has(item.id) || item.status !== "pronto") return item;
        untrackUrls(item.outputs.map((o) => o.url));
        return {
          ...item,
          outputs: [],
          outWidth: undefined,
          outHeight: undefined,
          avifSkipped: false,
          error: undefined,
          status: "processando" as const,
        };
      }),
    );
    void (async () => {
      for (const t of targets) {
        await runOne(t.id, t.file, t.name, t.sizeBytes, nextPreset, nextQuality);
      }
    })();
  }

  function handlePresetChange(nextId: string): void {
    const next = getImagePreset(nextId);
    setPresetId(nextId);
    if (next.webpQuality) setQuality(next.webpQuality);
    reprocess(
      items.filter((item) => item.status === "pronto"),
      next,
      next.webpQuality ?? quality,
    );
  }

  function handleQualityChange(next: number): void {
    setQuality(next);
    reprocess(
      items.filter((item) => item.status === "pronto"),
      preset,
      next,
    );
  }

  function handleInputChange(e: ChangeEvent<HTMLInputElement>): void {
    if (e.target.files) addFiles(Array.from(e.target.files));
    e.target.value = "";
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setDragging(true);
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragging(false);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setDragging(false);
    addFiles(Array.from(e.dataTransfer.files));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      inputRef.current?.click();
    }
  }

  function removeItem(id: string): void {
    setItems((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) untrackUrls(target.outputs.map((o) => o.url));
      return prev.filter((item) => item.id !== id);
    });
  }

  function clearDone(): void {
    setItems((prev) => {
      prev.forEach((item) => {
        if (item.status === "pronto") untrackUrls(item.outputs.map((o) => o.url));
      });
      return prev.filter((item) => item.status !== "pronto");
    });
  }

  /** Baixa o WebP de todas as prontas (principal p/ Elementor). */
  function downloadAll(): void {
    const ready = items.filter(
      (item) => item.status === "pronto" && item.outputs.length > 0,
    );
    void (async () => {
      for (const item of ready) {
        const primary = item.outputs[0];
        downloadBlob(primary.url, primary.name);
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    })();
  }

  const primaryOf = (item: ConvertItem): ConvertOutput | undefined => item.outputs[0];
  const totalBefore = items.reduce((acc, item) => acc + item.sizeBytes, 0);
  const totalAfter = items.reduce(
    (acc, item) => acc + (primaryOf(item)?.size ?? item.sizeBytes),
    0,
  );
  const totalSaved = items.length > 0 ? Math.max(0, calcSavedPct(totalBefore, totalAfter)) : 0;
  const doneCount = items.filter((item) => item.status === "pronto").length;
  const processingCount = items.filter((item) => item.status === "processando").length;

  const presetCard = (selected: boolean): string =>
    `rounded-xl border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
      selected
        ? "border-emerald-500 bg-emerald-500/10"
        : "border-zinc-800 bg-zinc-900 hover:border-zinc-600"
    }`;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <header>
          <h2 className="text-lg font-semibold text-white">Converter para web</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Resize sem upscale + WebP/AVIF no navegador. AVIF só é gerado se o navegador suportar
            encode — senão, use WebP agora e o AVIF sai na fase 2 (Tauri/ffmpeg).
          </p>
        </header>

        {/* Presets */}
        <div
          className="grid gap-3 sm:grid-cols-3"
          role="group"
          aria-label="Preset de conversão"
        >
          {CONVERT_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={presetId === p.id}
              onClick={() => handlePresetChange(p.id)}
              className={presetCard(presetId === p.id)}
            >
              <span className="block text-sm font-semibold text-white">{p.label}</span>
              <span className="mt-1 block text-xs leading-relaxed text-zinc-400">
                {p.description}
              </span>
              <span className="mt-2 block text-xs font-medium text-emerald-300">
                {p.formats.join(" + ").toUpperCase()}
              </span>
            </button>
          ))}
        </div>

        {/* Qualidade */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <label htmlFor="convert-quality" className="text-sm font-medium text-zinc-200">
            Qualidade WebP: <span className="text-white">{quality}</span>
          </label>
          <input
            id="convert-quality"
            type="range"
            min={MIN_QUALITY}
            max={MAX_QUALITY}
            step={1}
            value={quality}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              handleQualityChange(Number(e.target.value))
            }
            className="mt-2 w-full accent-emerald-400"
          />
          <p className="mt-1 text-xs text-zinc-500">
            Trocar o valor reconverte a lista. JPG fallback do preset 1200w sai em q82 fixo.
          </p>
        </div>

        {/* Dropzone */}
        <div
          role="button"
          tabIndex={0}
          aria-label="Adicionar imagens para converter: arraste arquivos ou pressione Enter para selecionar"
          onClick={() => inputRef.current?.click()}
          onKeyDown={handleKeyDown}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`flex min-h-40 flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-8 text-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
            dragging
              ? "border-emerald-400 bg-emerald-500/10"
              : "border-zinc-700 bg-zinc-900/50 hover:border-zinc-500"
          }`}
        >
          <p className="text-base font-medium text-white">Arraste imagens aqui</p>
          <p className="mt-1 text-sm text-zinc-500">JPG · PNG · WebP — ou pressione Enter</p>
          <span className="mt-4 inline-block rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-950">
            Selecionar imagens
          </span>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            multiple
            tabIndex={-1}
            aria-hidden="true"
            className="hidden"
            onChange={handleInputChange}
          />
        </div>

        {/* Lista */}
        <section aria-label="Imagens para converter">
          {items.length === 0 ? (
            <p className="rounded-xl border border-zinc-800 px-4 py-10 text-center text-sm text-zinc-500">
              Fila vazia — solte imagens na área acima.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-zinc-800">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
                    <th className="px-4 py-3 font-medium">Arquivo</th>
                    <th className="px-4 py-3 font-medium">Antes</th>
                    <th className="px-4 py-3 font-medium">Depois (WebP)</th>
                    <th className="px-4 py-3 font-medium">Downloads</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const primary = primaryOf(item);
                    const saved =
                      item.status === "pronto" && primary
                        ? Math.max(0, calcSavedPct(item.sizeBytes, primary.size))
                        : 0;
                    return (
                      <tr key={item.id} className="border-b border-zinc-800/60 last:border-0">
                        <td className="max-w-56 px-4 py-3">
                          <span className="block truncate font-medium text-white" title={item.name}>
                            {item.name}
                          </span>
                          {item.outWidth != null && item.outHeight != null ? (
                            <span className="mt-0.5 block text-xs text-zinc-500">
                              → {item.outWidth}×{item.outHeight}px · {preset.label}
                            </span>
                          ) : (
                            <span className="mt-0.5 block text-xs text-zinc-600">
                              {preset.label}
                            </span>
                          )}
                          {item.avifSkipped && (
                            <span className="mt-1 block text-xs leading-relaxed text-amber-300/80">
                              AVIF pulado: navegador não encoda — fase 2 (Tauri).
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
                        <td className="whitespace-nowrap px-4 py-3">
                          {item.status === "pronto" && primary ? (
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="text-zinc-200">{formatBytes(primary.size)}</span>
                              <span
                                className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                                  saved >= 30
                                    ? "bg-emerald-500/20 text-emerald-300"
                                    : "bg-amber-500/20 text-amber-300"
                                }`}
                              >
                                −{saved.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
                              </span>
                            </span>
                          ) : item.status === "processando" ? (
                            <span className="text-zinc-500">convertendo…</span>
                          ) : (
                            <span className="text-zinc-600">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {item.status === "pronto" ? (
                            <span className="flex flex-wrap gap-x-3 gap-y-1">
                              {item.outputs.map((o) => (
                                <a
                                  key={o.format}
                                  href={o.url}
                                  download={o.name}
                                  aria-label={`Baixar ${o.name}`}
                                  className="text-xs font-medium text-emerald-300 transition hover:text-emerald-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                                >
                                  {o.format.toUpperCase()}
                                </a>
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
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Rodapé */}
        {items.length > 0 && (
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 pt-4">
            <p className="text-sm text-zinc-400">
              Total: <span className="text-zinc-200">{formatBytes(totalBefore)}</span> →{" "}
              <span className="text-zinc-200">{formatBytes(totalAfter)}</span>{" "}
              <span className="font-medium text-emerald-300">
                (−{totalSaved.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%)
              </span>
              {processingCount > 0 && (
                <span className="ml-2 text-amber-300">· {processingCount} convertendo…</span>
              )}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={downloadAll}
                disabled={doneCount === 0}
                title="Baixar o WebP de todas as imagens prontas (vão para a pasta Downloads)"
                className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Baixar WebP de todas ({doneCount})
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
