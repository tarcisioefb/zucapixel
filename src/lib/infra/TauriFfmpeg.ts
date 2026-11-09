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
import { mkdir, remove } from "@tauri-apps/plugin-fs";
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

/** Pixel format do 1º stream de vídeo (`rgba`, `yuv420p`, …) ou null. */
export async function probePixFmt(path: string): Promise<string | null> {
  return invoke<string | null>("probe_pix_fmt", { path });
}

export interface VideoProbe {
  durationSec?: number | null;
  width?: number | null;
  height?: number | null;
}

/** Duração (s) e dimensões de um vídeo real. */
export async function probeVideo(path: string): Promise<VideoProbe> {
  return invoke<VideoProbe>("probe_video", { path });
}

/** Diálogo nativo de seleção (múltiplos vídeos). */
export async function pickVideoFiles(): Promise<string[]> {
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [{ name: "Vídeos", extensions: ["mp4", "mov", "m4v", "webm", "mkv"] }],
  });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

/** true se o pixel format carrega canal alpha. */
export function pixFmtHasAlpha(pixFmt: string | null | undefined): boolean {
  if (!pixFmt) return false;
  const token = pixFmt.toLowerCase();
  return ["rgba", "bgra", "argb", "abgr", "gbrap", "yuva", "ya"].some(
    (p) => token === p || token.startsWith(p),
  );
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
    // NOTE: o invoke USA camelCase (`jobId`) — o Tauri v2 converte p/ snake_case
    // sozinho no Rust. Com `job_id` ele rejeita ("missing required key jobId").
    await invoke<string>("run_ffmpeg", {
      args: ["-progress", "pipe:1", "-nostats", ...args],
      jobId,
    });
  } finally {
    unlisten();
  }
}

/** Apaga um arquivo gerado (ex.: saída maior que o original). */
export async function deleteFile(path: string): Promise<void> {
  await remove(path);
}

/** true se o path existe (via command Rust — não exige permissão fs:allow-exists). */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await probeMedia(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Devolve um caminho livre na pasta: `foto-1200w.webp`, `foto-1200w-2.webp`, …
 * Nunca sobrescreve nada silenciosamente.
 */
export async function uniquePath(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = `${dir}/${name}`;
  let n = 2;
  while (await fileExists(candidate)) {
    candidate = `${dir}/${stem}-${n}${ext}`;
    n += 1;
  }
  return candidate;
}

/**
 * Roda o sidecar `avifenc` (NÃO recebe flags `-progress`: não são do ffmpeg).
 * Mesmo evento de progresso (`ffmpeg-progress`) para reaproveitar a UI.
 */
export async function runAvifenc(
  args: string[],
  jobId: string,
  onProgress?: (p: number) => void,
): Promise<void> {
  const unlisten = await listen<FfmpegProgressPayload>("ffmpeg-progress", (event) => {
    if (event.payload.jobId === jobId) onProgress?.(event.payload.progress);
  });
  try {
    await invoke<string>("run_avifenc", { args, jobId });
  } finally {
    unlisten();
  }
}

/**
 * Pasta padrão de saída: `~/Pictures/Otimizadas` (criada se não existir).
 * Coberta pelo `fs:scope` ($PICTURE/**) das capabilities.
 */
export async function ensureOutputDir(): Promise<string> {
  const dir = await join(await pictureDir(), "Otimizadas");
  // mkdir recursivo é idempotente (não falha se já existir) e só exige
  // `fs:allow-mkdir` — evita pedir `fs:allow-exists` só p/ checar antes.
  await mkdir(dir, { recursive: true });
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

/**
 * Assina drag-drop de arquivos na JANELA inteira (retorna paths reais do SO).
 * `onDragActive` liga/desliga o overlay visual durante o arraste.
 */
export async function onWindowDragDrop(callbacks: {
  onDrop: (paths: string[]) => void;
  onDragActive: (active: boolean) => void;
}): Promise<() => void> {
  const unlisten = await getCurrentWebviewWindow().onDragDropEvent((event) => {
    const t = event.payload.type;
    if (t === "drop") {
      callbacks.onDragActive(false);
      callbacks.onDrop(event.payload.paths);
    } else if (t === "enter" || t === "over") {
      callbacks.onDragActive(true);
    } else {
      callbacks.onDragActive(false);
    }
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
