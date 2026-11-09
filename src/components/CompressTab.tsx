import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, KeyboardEvent } from "react";
import { getImagePreset } from "../lib/convert/presets";
import { checkImage } from "../lib/convert/preflight";
import { calcSavedPct } from "../lib/convert/jobs";
import { buildOutputName } from "../lib/convert/slugify";
import {
  canvasToBlob,
  formatBytes,
  loadImageElement,
  makeId,
} from "./fileUtils";

type CompressMode = "jpg" | "png";

type CompressStatus = "processando" | "pronto" | "erro";

interface CompressItem {
  id: string;
  name: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  status: CompressStatus;
  file: File;
  outputSize?: number;
  outputUrl?: string;
  outputName?: string;
  error?: string;
}

const ACCEPT = "image/jpeg,image/png";
const MIN_QUALITY = 50;
const MAX_QUALITY = 95;
const DEFAULT_QUALITY = 75;

const JPG_PRESET = getImagePreset("compress-jpg");
const PNG_PRESET = getImagePreset("compress-png");

interface CompressedImage {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * Compressão REAL no navegador (canvas), sem backend:
 * - JPG: re-encode `image/jpeg` com a qualidade escolhida + strip EXIF
 *   (o canvas descarta metadados). Fundo branco para PNG com alpha,
 *   senão a transparência vira preta no JPG.
 * - PNG: re-encode `image/png` lossless (fase 2 pngquant comprime mais).
 * O <img> já aplica a orientação EXIF, então o canvas sai correto.
 */
async function compressImage(
  file: File,
  mode: CompressMode,
  quality: number,
): Promise<CompressedImage> {
  const src = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(src);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    if (mode === "jpg") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0);
    const blob =
      mode === "jpg"
        ? await canvasToBlob(canvas, "image/jpeg", quality / 100)
        : await canvasToBlob(canvas, "image/png");
    return { blob, width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(src);
  }
}

export function CompressTab() {
  const [mode, setMode] = useState<CompressMode>("jpg");
  const [quality, setQuality] = useState<number>(DEFAULT_QUALITY);
  const [items, setItems] = useState<CompressItem[]>([]);
  const [dragging, setDragging] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const urlsRef = useRef<string[]>([]);

  // Libera object URLs ao desmontar (remove/clear já revogam individualmente).
  useEffect(() => {
    const bag = urlsRef.current;
    return () => {
      bag.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  function trackUrl(url: string): void {
    urlsRef.current.push(url);
  }

  function untrackUrl(url: string): void {
    URL.revokeObjectURL(url);
    urlsRef.current = urlsRef.current.filter((u) => u !== url);
  }

  /** Comprime um item e atualiza a lista. Chamado na adição e ao trocar modo/qualidade. */
  async function runOne(
    id: string,
    file: File,
    origName: string,
    origSize: number,
    nextMode: CompressMode,
    nextQuality: number,
  ): Promise<void> {
    try {
      const { blob, width, height } = await compressImage(file, nextMode, nextQuality);
      // BAD_FILENAME não bloqueia aqui: o nome de saída já sai slugificado.
      const issues = checkImage({
        sizeBytes: origSize,
        width,
        targetWidth: null,
        alt: origName,
        name: origName,
        isCompress: true,
      }).filter((issue) => issue.code !== "BAD_FILENAME");
      const errors = issues.filter((issue) => issue.level === "error");
      if (errors.length > 0) {
        setItems((prev) =>
          prev.map((item) =>
            item.id === id
              ? { ...item, status: "erro" as const, error: errors.map((e) => e.message).join(" ") }
              : item,
          ),
        );
        return;
      }
      const ext = nextMode === "jpg" ? "jpg" : "png";
      const outputName = buildOutputName(origName, "comprimido", null, ext);
      const outputUrl = URL.createObjectURL(blob);
      trackUrl(outputUrl);
      setItems((prev) =>
        prev.map((item) => {
          if (item.id !== id) return item;
          if (item.outputUrl) untrackUrl(item.outputUrl);
          return {
            ...item,
            status: "pronto" as const,
            width,
            height,
            outputSize: blob.size,
            outputUrl,
            outputName,
            error: undefined,
          };
        }),
      );
    } catch {
      setItems((prev) =>
        prev.map((item) =>
          item.id === id
            ? { ...item, status: "erro" as const, error: "Falha ao processar a imagem no navegador." }
            : item,
        ),
      );
    }
  }

  function addFiles(files: File[]): void {
    if (files.length === 0) return;
    const fresh: CompressItem[] = files.map((file) => {
      const isJpeg = file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name);
      const isPng = file.type === "image/png" || /\.png$/i.test(file.name);
      if (!isJpeg && !isPng) {
        return {
          id: makeId(),
          name: file.name,
          sizeBytes: file.size,
          status: "erro" as const,
          file,
          error: "Tipo não suportado — envie apenas JPG ou PNG.",
        };
      }
      return {
        id: makeId(),
        name: file.name,
        sizeBytes: file.size,
        status: "processando" as const,
        file,
      };
    });
    setItems((prev) => [...prev, ...fresh]);
    // Sequencial para não estourar memória com fotos grandes.
    void (async () => {
      for (const item of fresh) {
        if (item.status !== "processando") continue;
        await runOne(item.id, item.file, item.name, item.sizeBytes, mode, quality);
      }
    })();
  }

  function reprocess(targets: CompressItem[], nextMode: CompressMode, nextQuality: number): void {
    if (targets.length === 0) return;
    const ids = new Set(targets.map((t) => t.id));
    setItems((prev) =>
      prev.map((item) => {
        if (!ids.has(item.id) || item.status !== "pronto") return item;
        if (item.outputUrl) untrackUrl(item.outputUrl);
        const { outputUrl: _drop, outputSize: _dropSize, outputName: _dropName, ...rest } = item;
        void _drop;
        void _dropSize;
        void _dropName;
        return { ...rest, status: "processando" as const };
      }),
    );
    void (async () => {
      for (const t of targets) {
        await runOne(t.id, t.file, t.name, t.sizeBytes, nextMode, nextQuality);
      }
    })();
  }

  function handleModeChange(next: CompressMode): void {
    setMode(next);
    reprocess(
      items.filter((item) => item.status === "pronto"),
      next,
      quality,
    );
  }

  function handleQualityChange(next: number): void {
    setQuality(next);
    reprocess(
      items.filter((item) => item.status === "pronto"),
      mode,
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
      if (target?.outputUrl) untrackUrl(target.outputUrl);
      return prev.filter((item) => item.id !== id);
    });
  }

  function clearDone(): void {
    setItems((prev) => {
      prev.forEach((item) => {
        if (item.status === "pronto" && item.outputUrl) untrackUrl(item.outputUrl);
      });
      return prev.filter((item) => item.status !== "pronto");
    });
  }

  /** Baixa todos os prontos (o navegador salva em ~/Downloads; no Tauri irá p/ a pasta escolhida). */
  function downloadAll(): void {
    const ready = items.filter(
      (item): item is CompressItem & { outputUrl: string; outputName: string } =>
        item.status === "pronto" && item.outputUrl != null && item.outputName != null,
    );
    void (async () => {
      for (const item of ready) {
        const a = document.createElement("a");
        a.href = item.outputUrl;
        a.download = item.outputName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    })();
  }

  const totalBefore = items.reduce((acc, item) => acc + item.sizeBytes, 0);
  const totalAfter = items.reduce((acc, item) => acc + (item.outputSize ?? item.sizeBytes), 0);
  const totalSaved = items.length > 0 ? Math.max(0, calcSavedPct(totalBefore, totalAfter)) : 0;
  const doneCount = items.filter((item) => item.status === "pronto").length;
  const processingCount = items.filter((item) => item.status === "processando").length;

  const modeCard = (selected: boolean): string =>
    `rounded-xl border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
      selected
        ? "border-emerald-500 bg-emerald-500/10"
        : "border-zinc-800 bg-zinc-900 hover:border-zinc-600"
    }`;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <header>
          <h2 className="text-lg font-semibold text-white">Comprimir imagens</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Estilo iLoveIMG: mantém formato e dimensões, só reduz o peso. Compressão real no
            navegador (JPG re-encode + remove EXIF · PNG lossless). O download vai para a sua pasta
            de Downloads.
          </p>
        </header>

        {/* Seletor de modo */}
        <div className="grid gap-3 sm:grid-cols-2" role="group" aria-label="Modo de compressão">
          <button
            type="button"
            aria-pressed={mode === "jpg"}
            onClick={() => handleModeChange("jpg")}
            className={modeCard(mode === "jpg")}
          >
            <span className="block text-sm font-semibold text-white">Comprimir JPG</span>
            <span className="mt-1 block text-xs leading-relaxed text-zinc-400">
              {JPG_PRESET.description}
            </span>
            <span className="mt-2 block text-xs font-medium text-emerald-300">
              Economia esperada: −40% a −70%
            </span>
          </button>
          <button
            type="button"
            aria-pressed={mode === "png"}
            onClick={() => handleModeChange("png")}
            className={modeCard(mode === "png")}
          >
            <span className="block text-sm font-semibold text-white">Comprimir PNG</span>
            <span className="mt-1 block text-xs leading-relaxed text-zinc-400">
              {PNG_PRESET.description}
            </span>
            <span className="mt-2 block text-xs font-medium text-emerald-300">
              Economia esperada: −20% a −50%
            </span>
          </button>
        </div>

        {/* Qualidade JPG / nota PNG */}
        {mode === "jpg" ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <label htmlFor="compress-quality" className="text-sm font-medium text-zinc-200">
              Qualidade JPG: <span className="text-white">{quality}</span>
            </label>
            <input
              id="compress-quality"
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
              {MIN_QUALITY} = arquivo menor (mais perda) · {MAX_QUALITY} = qualidade maior (menos
              economia). Trocar o valor recomprime a lista.
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-sm text-zinc-300">
              PNG lossless nível 9 — sem perda de qualidade e sem mudar dimensões.
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              A fase 2 (pngquant) comprime ainda mais; a fase 1 já reduz de −20% a −50%.
            </p>
          </div>
        )}

        {/* Dropzone */}
        <div
          role="button"
          tabIndex={0}
          aria-label="Adicionar imagens para comprimir: arraste arquivos JPG ou PNG ou pressione Enter para selecionar"
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
          <p className="text-base font-medium text-white">Arraste JPG ou PNG aqui</p>
          <p className="mt-1 text-sm text-zinc-500">ou pressione Enter para selecionar arquivos</p>
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
        <section aria-label="Imagens para comprimir">
          {items.length === 0 ? (
            <p className="rounded-xl border border-zinc-800 px-4 py-10 text-center text-sm text-zinc-500">
              Nenhuma imagem ainda — solte arquivos JPG/PNG na área acima.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-zinc-800">
              <table className="w-full min-w-[680px] text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
                    <th className="px-4 py-3 font-medium">Arquivo</th>
                    <th className="px-4 py-3 font-medium">Antes</th>
                    <th className="px-4 py-3 font-medium">Antes × depois</th>
                    <th className="px-4 py-3 font-medium">Depois</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const after = item.outputSize ?? item.sizeBytes;
                    const max = Math.max(item.sizeBytes, after);
                    const saved =
                      item.status === "pronto" && item.outputSize != null
                        ? Math.max(0, calcSavedPct(item.sizeBytes, item.outputSize))
                        : 0;
                    return (
                      <tr key={item.id} className="border-b border-zinc-800/60 last:border-0">
                        <td className="max-w-56 px-4 py-3">
                          <span className="block truncate font-medium text-white" title={item.name}>
                            {item.name}
                          </span>
                          {item.width != null && item.height != null && (
                            <span className="mt-0.5 block text-xs text-zinc-500">
                              {item.width}×{item.height}px
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
                          <div className="flex w-32 flex-col gap-1.5" aria-hidden="true">
                            <div
                              title={`Antes: ${formatBytes(item.sizeBytes)}`}
                              className="h-1.5 rounded-full bg-zinc-600"
                              style={{ width: `${(item.sizeBytes / max) * 100}%` }}
                            />
                            <div
                              title={`Depois: ${formatBytes(after)}`}
                              className="h-1.5 rounded-full bg-emerald-400"
                              style={{ width: `${(after / max) * 100}%` }}
                            />
                          </div>
                          <span className="sr-only">
                            Antes {formatBytes(item.sizeBytes)}, depois {formatBytes(after)}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          {item.status === "pronto" && item.outputSize != null ? (
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="text-zinc-200">{formatBytes(item.outputSize)}</span>
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
                            <span className="text-zinc-500">comprimindo…</span>
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
                          {item.status === "pronto" &&
                            item.outputUrl != null &&
                            item.outputName != null && (
                              <a
                                href={item.outputUrl}
                                download={item.outputName}
                                aria-label={`Baixar ${item.outputName}`}
                                className="mr-3 text-xs font-medium text-emerald-300 transition hover:text-emerald-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                              >
                                baixar
                              </a>
                            )}
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
                <span className="ml-2 text-amber-300">· {processingCount} comprimindo…</span>
              )}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={downloadAll}
                disabled={doneCount === 0}
                title="Baixar todas as imagens comprimidas (vão para a pasta Downloads)"
                className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Baixar todas ({doneCount})
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
