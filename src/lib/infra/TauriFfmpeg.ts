/**
 * TauriFfmpeg.ts — Ponte do front com o ffmpeg real (sidecar) no app desktop.
 *
 * - No navegador (Vite puro): `isTauri()` é false e nada aqui é chamado.
 * - No Tauri: `runFfmpeg` invoca o command Rust `run_ffmpeg` (sidecar
 *   `binaries/ffmpeg`) com `-progress pipe:1` e repassa o progresso via
 *   evento `ffmpeg-progress` para a barra do job.
 * - Arquivos entram como PATHS reais (dialog nativo ou drag-drop da janela),
 *   então o ffmpeg lê/escreve direto no FS — sem limitação de escopo do
 *   plugin-fs (que só rege as APIs JS, não o processo sidecar).
 */
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { join, pictureDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { exists, mkdir, remove } from "@tauri-apps/plugin-fs";
import { revealItemInDir, openPath } from "@tauri-apps/plugin-opener";

export { convertFileSrc };

/** true quando rodando dentro da janela Tauri (com GlobalTauri ligado). */
export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return "__TAURI_INTERNALS__" in w || "__TAURI__" in w;
}

export interface ProbeResult {
  kind: string;
  width?: number | null;
  height?: number | null;
  sizeBytes: number;
  durationSec?: number | null;
}

interface FfmpegProgressPayload {
  jobId: string;
  progress: number;
}

/** Tamanho/tipo de um arquivo real (sem ler o conteúdo). */
export async function probeMedia(path: string): Promise<ProbeResult> {
  return invoke<ProbeResult>("probe_media", { path });
}

/**
 * Roda o sidecar ffmpeg. `onProgress` recebe 0..1 (imagens: poucos eventos,
 * a UI mostra "processando" até concluir).
 */
export async function runFfmpeg(
  args: string[],
  jobId: string,
  onProgress?: (p: number) => void,
): Promise<void> {
  const unlisten = await listen<FfmpegProgressPayload>("ffmpeg-progress", (event) => {
    if (event.payload.jobId === jobId) onProgress?.(event.payload.progress);
  });
  try {
    // NOTE: a chave precisa ser snake_case (`job_id`) — o invoke NÃO converte
    // camelCase automaticamente; com `jobId` o Rust rejeita ("missing argument").
    await invoke<string>("run_ffmpeg", {
      args: ["-progress", "pipe:1", "-nostats", ...args],
      job_id: jobId,
    });
  } finally {
    unlisten();
  }
}

/** Apaga um arquivo gerado (ex.: saída maior que o original). */
export async function deleteFile(path: string): Promise<void> {
  await remove(path);
}

/**
 * Pasta padrão de saída: `~/Pictures/Otimizadas` (criada se não existir).
 * Coberta pelo `fs:scope` ($PICTURE/**) das capabilities.
 */
export async function ensureOutputDir(): Promise<string> {
  const dir = await join(await pictureDir(), "Otimizadas");
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

/** Diálogo nativo de seleção (múltiplos arquivos de imagem). */
export async function pickImageFiles(allowWebp: boolean): Promise<string[]> {
  const extensions = allowWebp
    ? ["jpg", "jpeg", "png", "webp"]
    : ["jpg", "jpeg", "png"];
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [{ name: "Imagens", extensions }],
  });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

/** Assina o drop de arquivos na JANELA (retorna paths reais do SO). */
export async function onWindowDrop(
  cb: (paths: string[]) => void,
): Promise<() => void> {
  const unlisten = await getCurrentWebviewWindow().onDragDropEvent((event) => {
    if (event.payload.type === "drop") cb(event.payload.paths);
  });
  return unlisten;
}

/** Revela o arquivo no Finder (fallback: abre a pasta). */
export async function revealFile(path: string, dir: string): Promise<void> {
  try {
    await revealItemInDir(path);
  } catch {
    await openPath(dir);
  }
}

/** Abre uma pasta no Finder. */
export async function openFolder(dir: string): Promise<void> {
  await openPath(dir);
}

/** `"/a/b/foto.png"` → `"/a/b"`. */
export function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

/** `"/a/b/foto.png"` → `"foto.png"`. */
export function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}
