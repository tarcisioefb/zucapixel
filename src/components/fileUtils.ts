/**
 * fileUtils.ts — Helpers compartilhados das tabs de mídia (Compress/Converter).
 * Tudo roda no navegador via canvas; o Tauri/ffmpeg entra na fase 2.
 */

/** Id único sem dependência externa. */
export function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Formata bytes em pt-BR (B / KB / MB). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} KB`;
  const mb = kb / 1024;
  return `${mb.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
}

export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode"));
    img.src = src;
  });
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("encode"));
    }, mime, quality);
  });
}

/** Dispara o download de um blob com o nome dado. */
export function downloadBlob(url: string, name: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

let avifSupportCache: Promise<boolean> | null = null;

/**
 * Detecta se o navegador consegue ENCODAR avif via canvas.
 * (Chrome: sim · Safari/Firefox: geralmente não — cai p/ WebP + aviso fase 2.)
 */
export function supportsAvifEncode(): Promise<boolean> {
  if (!avifSupportCache) {
    avifSupportCache = (async () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const blob = await canvasToBlob(canvas, "image/avif", 0.5);
        return blob.size > 0;
      } catch {
        return false;
      }
    })();
  }
  return avifSupportCache;
}
