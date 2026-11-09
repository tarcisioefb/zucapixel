import { useRef, useState } from "react";
import type { ChangeEvent, DragEvent, KeyboardEvent } from "react";
import { getImagePreset } from "../lib/convert/presets";
import { checkImage } from "../lib/convert/preflight";
import { calcSavedPct } from "../lib/convert/jobs";

type CompressMode = "jpg" | "png";

type CompressStatus = "pronto" | "erro";

interface CompressItem {
  id: string;
  name: string;
  sizeBytes: number;
  width?: number;
  status: CompressStatus;
  outputSize?: number;
  error?: string;
}

const ACCEPT = "image/jpeg,image/png";
const MIN_QUALITY = 50;
const MAX_QUALITY = 95;
const DEFAULT_QUALITY = 75;
/** compress-only não faz resize: a largura real viria do backend (probe ffmpeg). */
const FALLBACK_WIDTH = 1920;

const JPG_PRESET = getImagePreset("compress-jpg");
const PNG_PRESET = getImagePreset("compress-png");

/** Id único sem dependência externa. */
function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `compress-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Hash simples e determinístico (variação estável por nome de arquivo). */
function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * SIMULAÇÃO front-only para demo (sem backend rodando).
 * JPG: fator = 1 - (100-q)/45, clamped 0.25–0.9 (q75 ≈ 0.44, ~-56%)
 * PNG: fator 0.65.
 * Variação determinística de ±5% por nome para a demo não ficar idêntica.
 */
function simulateOutputSize(
  name: string,
  sizeBytes: number,
  mode: CompressMode,
  quality: number,
): number {
  const variation = ((hashName(name) % 11) - 5) / 100;
  const base = mode === "jpg" ? 1 - (100 - quality) / 45 : 0.65;
  const factor = Math.min(0.9, Math.max(0.25, base + variation));
  return Math.max(1, Math.round(sizeBytes * factor));
}

/** Formata bytes em pt-BR (B / KB / MB). */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} KB`;
  const mb = kb / 1024;
  return `${mb.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
}

export function CompressTab() {
  const [mode, setMode] = useState<CompressMode>("jpg");
  const [quality, setQuality] = useState<number>(DEFAULT_QUALITY);
  const [items, setItems] = useState<CompressItem[]>([]);
  const [dragging, setDragging] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function addFiles(files: File[]): void {
    if (files.length === 0) return;
    const next: CompressItem[] = files.map((file): CompressItem => {
      const isJpeg = file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name);
      const isPng = file.type === "image/png" || /\.png$/i.test(file.name);
      if (!isJpeg && !isPng) {
        return {
          id: makeId(),
          name: file.name,
          sizeBytes: file.size,
          status: "erro",
          error: "Tipo não suportado — envie apenas JPG ou PNG.",
        };
      }
      const issues = checkImage({
        sizeBytes: file.size,
        width: FALLBACK_WIDTH,
        targetWidth: null,
        alt: file.name,
        name: file.name,
        isCompress: true,
      });
      const errors = issues.filter((issue) => issue.level === "error");
      if (errors.length > 0) {
        return {
          id: makeId(),
          name: file.name,
          sizeBytes: file.size,
          status: "erro",
          error: errors.map((issue) => issue.message).join(" "),
        };
      }
      return {
        id: makeId(),
        name: file.name,
        sizeBytes: file.size,
        status: "pronto",
        outputSize: simulateOutputSize(file.name, file.size, mode, quality),
      };
    });
    setItems((prev) => [...prev, ...next]);
  }

  function handleModeChange(next: CompressMode): void {
    setMode(next);
    setItems((prev) =>
      prev.map((item) =>
        item.status === "pronto"
          ? { ...item, outputSize: simulateOutputSize(item.name, item.sizeBytes, next, quality) }
          : item,
      ),
    );
  }

  function handleQualityChange(next: number): void {
    setQuality(next);
    setItems((prev) =>
      prev.map((item) =>
        item.status === "pronto"
          ? { ...item, outputSize: simulateOutputSize(item.name, item.sizeBytes, mode, next) }
          : item,
      ),
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
    setItems((prev) => prev.filter((item) => item.id !== id));
  }

  function clearDone(): void {
    setItems((prev) => prev.filter((item) => item.status !== "pronto"));
  }

  const totalBefore = items.reduce((acc, item) => acc + item.sizeBytes, 0);
  const totalAfter = items.reduce((acc, item) => acc + (item.outputSize ?? item.sizeBytes), 0);
  const totalSaved = items.length > 0 ? calcSavedPct(totalBefore, totalAfter) : 0;
  const doneCount = items.filter((item) => item.status === "pronto").length;

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
            Estilo iLoveIMG: mantém formato e dimensões, só reduz o peso. Demonstração com simulação
            no front (sem backend).
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
              economia).
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
              <table className="w-full min-w-[640px] text-left text-sm">
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
                        ? calcSavedPct(item.sizeBytes, item.outputSize)
                        : 0;
                    return (
                      <tr key={item.id} className="border-b border-zinc-800/60 last:border-0">
                        <td className="max-w-56 px-4 py-3">
                          <span className="block truncate font-medium text-white" title={item.name}>
                            {item.name}
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
                          ) : (
                            <span className="text-zinc-600">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-block rounded-full px-2.5 py-0.5 text-xs ${
                              item.status === "pronto"
                                ? "bg-emerald-500/20 text-emerald-300"
                                : "bg-red-500/20 text-red-300"
                            }`}
                          >
                            {item.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
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
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled
                title="Em breve: baixar todas as imagens comprimidas em um arquivo .zip"
                className="rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Exportar ZIP (futuro)
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
