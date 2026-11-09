/**
 * presets.ts — Presets de conversão image-first.
 *
 * Estratégia em 2 fases (importante):
 *
 * - FASE 1 (este app / ffmpeg): scale + encode WebP/JPG via ffmpeg.
 *   Rápido, sem dependência nativa extra, roda no Tauri com ffmpeg
 *   embutido (sidecar) ou do sistema.
 * - FASE 2 (futuro / vips-sharp): batch AVIF via sharp (libvips).
 *   AVIF via ffmpeg (libaom) é lento demais para UI interativa, por
 *   isso `buildImageFfmpegArgs` REJEITA `avif` de propósito — o AVIF
 *   sai da fila fase 2, não do ffmpeg. Ver comentário em
 *   `buildImageFfmpegArgs`.
 *
 * Regra de ouro Elementor: nunca servir PNG/JPG original pesado.
 * Todo `<img>` deve apontar para `-<largura>w.webp` (ou `.avif`)
 * com `width/height` explícitos para não estourar CLS.
 */

import { slugify, stripExtension } from './slugify';

/** Formatos de saída de imagem suportados na fase 1 + 2. `png` = compressão lossless otimizada (estilo iLoveIMG). */
export type ImageFormat = 'webp' | 'avif' | 'jpg' | 'png';

export interface ImagePreset {
  /** Identificador estável — usado em `buildOutputName` e nos Jobs. */
  id: string;
  /** Rótulo exibido na UI. */
  label: string;
  /**
   * Largura alvo em px. `null` = sem resize (ex.: logo lossless).
   * O filtro de scale nunca faz upscale (usa `min(alvo,iw)`).
   */
  width: number | null;
  /** Formatos a gerar, em ordem de preferência. */
  formats: ImageFormat[];
  /** Qualidade 0–100 para WebP (fase 1, ffmpeg libwebp). */
  webpQuality?: number;
  /** Qualidade 0–100 para AVIF (fase 2, sharp/vips). */
  avifQuality?: number;
  /** Qualidade 0–100 para JPEG fallback (fase 1). */
  jpegQuality?: number;
  /**
   * Esforço de compressão (0–6 libwebp / cpu-used VP9).
   * Maior = arquivo menor, porém mais lento.
   */
  effort?: number;
  /** `true` = encode lossless (só faz sentido p/ logo). */
  lossless?: boolean;
  /** `true` = mantém o PNG original ao lado (fallback). */
  keepOriginal?: boolean;
  /** `true` = preset de compressão estilo iLoveIMG (mantém formato/dimensões, só reduz KB). */
  compressOnly?: boolean;
  /** Nível de compressão PNG 0–9 (default 9, lossless). */
  pngCompressionLevel?: number;
  description: string;
  /** Acima disso (KB) a UI exibe aviso — não bloqueia. */
  maxKBWarning: number;
}

export const IMAGE_PRESETS: ImagePreset[] = [
  {
    id: '800w',
    label: 'Cards / Mobile — 800px',
    width: 800,
    formats: ['webp', 'avif'],
    webpQuality: 85,
    avifQuality: 65,
    effort: 4,
    description: 'Cards, grids e mobile. WebP imediato (fase 1) + AVIF batch (fase 2).',
    maxKBWarning: 100,
  },
  {
    id: '1200w',
    label: 'Container padrão — 1200px',
    width: 1200,
    formats: ['webp', 'avif', 'jpg'],
    webpQuality: 85,
    avifQuality: 65,
    jpegQuality: 82,
    effort: 4,
    description:
      'Default para a maioria das seções Elementor (container ~1140px + retina parcial). JPG só como fallback.',
    maxKBWarning: 150,
  },
  {
    id: '1920w',
    label: 'Hero fullscreen — 1920px',
    width: 1920,
    formats: ['webp', 'avif'],
    webpQuality: 85,
    avifQuality: 65,
    effort: 4,
    description: 'Hero fullscreen. Se passar de ~150KB após encode, a preflight avisa.',
    maxKBWarning: 150,
  },
  {
    id: 'logo-lossless',
    label: 'Logo — sem resize (lossless)',
    width: null,
    formats: ['webp'],
    webpQuality: 100,
    effort: 6,
    lossless: true,
    keepOriginal: true,
    description: 'Logos e marcas: sem resize, WebP lossless + mantém o PNG original.',
    maxKBWarning: 80,
  },
  {
    id: 'compress-jpg',
    label: 'Comprimir JPG — manter tamanho',
    width: null,
    formats: ['jpg'],
    jpegQuality: 75,
    effort: 4,
    compressOnly: true,
    description:
      'Estilo iLoveIMG Compress: mantém dimensões/formato, re-encode mozjpeg-like q75 + strip EXIF. Ideal p/ foto que precisa continuar JPG no WP.',
    maxKBWarning: 300,
  },
  {
    id: 'compress-png',
    label: 'Comprimir PNG — manter tamanho',
    width: null,
    formats: ['png'],
    pngCompressionLevel: 9,
    effort: 4,
    compressOnly: true,
    keepOriginal: false,
    description:
      'Estilo iLoveIMG Compress: PNG lossy-less otimizado (-pred mixed, level 9) sem resize. Fase 2 (vips/pngquant) comprime mais; fase 1 já tira 20-50%.',
    maxKBWarning: 300,
  },
];

/** Recupera um preset de imagem pelo id (lança erro se inexistente). */
export function getImagePreset(id: string): ImagePreset {
  const found = IMAGE_PRESETS.find((p) => p.id === id);
  if (!found) throw new Error(`ImagePreset desconhecido: "${id}"`);
  return found;
}

// ---------------------------------------------------------------------------
// Vídeo (secundário — imagem é o foco)
// ---------------------------------------------------------------------------

export type VideoKind = 'mp4' | 'webm' | 'av1';

export interface VideoPreset {
  id: string;
  label: string;
  /**
   * Largura alvo (altura proporcional, par). `null` = sem resize,
   * mantém as dimensões do original (só converte/comprime).
   */
  width: number | null;
  fps: number;
  crfMp4: number;
  crfVp9: number;
  /**
   * Trava de duração em segundos — ffmpeg `-t`. `null` = sem corte,
   * converte o vídeo inteiro.
   */
  durationCap: number | null;
  description: string;
  /** Args base (sem `-i`/input/output) para H.264. */
  ffmpegMp4Args: string[];
  /** Args base (sem `-i`/input/output) para VP9. */
  ffmpegWebmArgs: string[];
  /** Args base opcionais para AV1 (libsvtav1). */
  ffmpegAv1Args?: string[];
}

export const VIDEO_PRESETS: VideoPreset[] = [
  {
    id: 'hero-light',
    label: 'Hero leve — 720p / 6s (<2MB)',
    width: 1280,
    fps: 30,
    crfMp4: 28,
    crfVp9: 33,
    durationCap: 6,
    description: 'Hero em vídeo: 720p, mudo, máx. 6s. Alvo <2MB.',
    ffmpegMp4Args: ['-c:v', 'libx264', '-crf', '28', '-preset', 'veryfast'],
    ffmpegWebmArgs: ['-c:v', 'libvpx-vp9', '-crf', '33', '-b:v', '0', '-deadline', 'good', '-cpu-used', '4'],
  },
  {
    id: 'bg-720p',
    label: 'Background — 720p / 8s',
    width: 1280,
    fps: 30,
    crfMp4: 26,
    crfVp9: 31,
    durationCap: 8,
    description: 'Background de seção Elementor: 720p mudo em loop.',
    ffmpegMp4Args: ['-c:v', 'libx264', '-crf', '26', '-preset', 'veryfast'],
    ffmpegWebmArgs: ['-c:v', 'libvpx-vp9', '-crf', '31', '-b:v', '0', '-deadline', 'good', '-cpu-used', '4'],
  },
  {
    id: 'hq-1080p',
    label: 'Alta qualidade — 1080p / 10s',
    width: 1920,
    fps: 30,
    crfMp4: 23,
    crfVp9: 28,
    durationCap: 10,
    description: 'Quando qualidade importa mais que peso. Máx. 10s.',
    ffmpegMp4Args: ['-c:v', 'libx264', '-crf', '23', '-preset', 'medium'],
    ffmpegWebmArgs: ['-c:v', 'libvpx-vp9', '-crf', '28', '-b:v', '0', '-deadline', 'good', '-cpu-used', '2'],
  },
  {
    id: 'av1-ultra',
    label: 'AV1 ultra — 1080p / 10s (opcional)',
    width: 1920,
    fps: 30,
    crfMp4: 23,
    crfVp9: 28,
    durationCap: 10,
    description: 'Opcional: ~30–50% menor que H.264, porém encode lento. libsvtav1 crf38 preset8.',
    ffmpegMp4Args: ['-c:v', 'libx264', '-crf', '23', '-preset', 'medium'],
    ffmpegWebmArgs: ['-c:v', 'libvpx-vp9', '-crf', '28', '-b:v', '0'],
    ffmpegAv1Args: ['-c:v', 'libsvtav1', '-crf', '38', '-preset', '8'],
  },
];

/** Recupera um preset de vídeo pelo id (lança erro se inexistente). */
export function getVideoPreset(id: string): VideoPreset {
  const found = VIDEO_PRESETS.find((p) => p.id === id);
  if (!found) throw new Error(`VideoPreset desconhecido: "${id}"`);
  return found;
}

// ---------------------------------------------------------------------------
// Helpers ffmpeg
// ---------------------------------------------------------------------------

/**
 * Monta o filtro de scale com proteção anti-upscale.
 * Usa `min(alvo,iw)` para nunca ampliar + `lanczos` para qualidade.
 * Retorna `null` quando `width` é `null` (sem resize, ex.: logo).
 *
 * @example
 * buildFfmpegScaleFilter(1200) // "scale=w='min(1200,iw)':h=-2:flags=lanczos"
 * buildFfmpegScaleFilter(null) // null
 */
export function buildFfmpegScaleFilter(width: number | null): string | null {
  if (width === null) return null;
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error(`Largura inválida para scale: ${String(width)}`);
  }
  return `scale=w='min(${width},iw)':h=-2:flags=lanczos`;
}

/** Converte qualidade JPEG 0–100 para `q:v` do ffmpeg (1–31, menor = melhor). */
function jpegQualityToQScale(quality: number): number {
  const q = Math.round(1 + ((100 - quality) / 100) * 30);
  return Math.min(31, Math.max(1, q));
}

export interface ImageFfmpegOptions {
  /** `true` = WebP lossless (`-lossless 1`, ignora qualidade). */
  lossless?: boolean;
  /** Esforço libwebp 0–6 (default 4). */
  effort?: number;
}

/**
 * Monta os args do ffmpeg para UMA imagem (fase 1: webp/jpg).
 *
 * ⚠️ AVIF é rejeitado de propósito: encode AVIF via ffmpeg (libaom)
 * é lento demais para a UI. O AVIF sai na fase 2 via sharp/vips em
 * batch, fora do ffmpeg. Quem chamar com `format: 'avif'` recebe um
 * erro explicativo em vez de um encode de 5min travando a fila.
 */
export function buildImageFfmpegArgs(
  input: string,
  output: string,
  width: number | null,
  format: Exclude<ImageFormat, 'avif'> | ImageFormat,
  quality: number,
  opts: ImageFfmpegOptions = {},
): string[] {
  if (!input || !output) throw new Error('input/output são obrigatórios.');
  if (quality < 0 || quality > 100) throw new Error(`Qualidade fora de 0–100: ${quality}`);

  if (format === 'avif') {
    throw new Error(
      'AVIF não é gerado via ffmpeg (libaom muito lento). ' +
        'Use a fase 2 (sharp/vips batch) para AVIF; ffmpeg aqui faz scale+webp/jpg.',
    );
  }

  const scale = buildFfmpegScaleFilter(width);
  const args: string[] = ['-hide_banner', '-y', '-i', input];
  if (scale) args.push('-vf', scale);

  if (format === 'webp') {
    args.push(
      '-c:v', 'libwebp',
      ...(opts.lossless ? ['-lossless', '1'] : ['-quality', String(Math.round(quality))]),
      '-compression_level', String(opts.effort ?? 4),
    );
  } else if (format === 'png') {
    // Compressão PNG lossless otimizada (estilo iLoveIMG): sem resize por default.
    // Fase 2 (pngquant/oxipng via vips) comprime mais; aqui já remove ancillaries e usa pred mixed.
    args.push('-c:v', 'png', '-pred', 'mixed', '-compression_level', '9');
  } else {
    // jpg fallback/compress (mjpeg): q:v 1 (melhor) – 31 (pior). q75 ≈ q:v 8.
    args.push('-c:v', 'mjpeg', '-q:v', String(jpegQualityToQScale(quality)));
  }

  args.push(output);
  return args;
}

/**
 * Nome de saída de vídeo: `<slug>-<preset>.mp4|.webm`,
 * AV1 como `<slug>-<preset>-av1.mp4`, poster `<slug>-<preset>-poster.jpg`.
 */
export type VideoOutputKind = 'mp4' | 'webm' | 'av1' | 'poster';

export function buildVideoOutputName(
  original: string,
  presetId: string,
  kind: VideoOutputKind,
): string {
  const base = slugify(stripExtension(original.trim()));
  const preset = slugify(presetId);
  switch (kind) {
    case 'mp4':
      return `${base}-${preset}.mp4`;
    case 'webm':
      return `${base}-${preset}.webm`;
    case 'av1':
      return `${base}-${preset}-av1.mp4`;
    case 'poster':
      return `${base}-${preset}-poster.jpg`;
  }
}

/**
 * Monta os args do poster (frame em 1s, largura dada, JPG q3).
 * É o fallback/LCP do hero + og:image.
 */
export function buildPosterArgs(input: string, output: string, width: number): string[] {
  if (!input || !output) throw new Error('input/output são obrigatórios.');
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error(`Largura inválida para poster: ${String(width)}`);
  }
  return [
    '-hide_banner', '-y',
    '-ss', '1', '-i', input,
    '-frames:v', '1',
    '-vf', `scale=${width}:-2`,
    '-q:v', '3',
    output,
  ];
}

/**
 * Monta os args do ffmpeg para UM AVIF (desktop, libaom-av1).
 * Qualidade 0–100 mapeada para CRF 0–63 (q60 ≈ crf 25, nível Cloudinary).
 */
export function buildAvifFfmpegArgs(
  input: string,
  output: string,
  width: number | null,
  quality: number,
): string[] {
  if (!input || !output) throw new Error('input/output são obrigatórios.');
  if (quality < 0 || quality > 100) throw new Error(`Qualidade fora de 0–100: ${quality}`);

  const scale = buildFfmpegScaleFilter(width);
  const crf = Math.round(((100 - quality) / 100) * 63);

  const args: string[] = ['-hide_banner', '-y', '-i', input];
  if (scale) args.push('-vf', scale);
  args.push(
    '-c:v', 'libaom-av1',
    '-crf', String(crf),
    '-b:v', '0',
    '-cpu-used', '4',
    '-row-mt', '1',
    output,
  );
  return args;
}

/**
 * Monta os args do `avifenc` (libavif de referência, COM alpha).
 * Qualidade 0–100 (`-q`), velocidade 6, 4:2:0, todas as threads.
 */
export function buildAvifencArgs(
  input: string,
  output: string,
  quality: number,
): string[] {
  if (!input || !output) throw new Error('input/output são obrigatórios.');
  if (quality < 0 || quality > 100) throw new Error(`Qualidade fora de 0–100: ${quality}`);

  return [
    '-q', String(Math.round(quality)),
    '-s', '6',
    '-j', 'all',
    '-y', '420',
    input,
    output,
  ];
}

/**
 * Monta os args do ffmpeg para UM vídeo.
 * Sempre: fps + `-an` (mudo, padrão para bg/hero) + `faststart` no MP4 +
 * `yuv420p` (compat. máxima). Com `width` setado: scale anti-upscale.
 * Com `durationCap` setado: `-t` corta no limite.
 */
export function buildVideoArgs(
  input: string,
  output: string,
  preset: VideoPreset,
  kind: VideoKind,
): string[] {
  if (!input || !output) throw new Error('input/output são obrigatórios.');

  let codecArgs: string[];
  if (kind === 'mp4') codecArgs = preset.ffmpegMp4Args;
  else if (kind === 'webm') codecArgs = preset.ffmpegWebmArgs;
  else {
    if (!preset.ffmpegAv1Args) {
      throw new Error(`Preset "${preset.id}" não possui args AV1 (ffmpegAv1Args ausente).`);
    }
    codecArgs = preset.ffmpegAv1Args;
  }

  const vf = preset.width != null
    ? `scale=w='min(${preset.width},iw)':h=-2:flags=lanczos,fps=${preset.fps}`
    : `fps=${preset.fps}`;

  const args: string[] = [
    '-hide_banner', '-y',
    '-i', input,
    '-vf', vf,
  ];
  if (preset.durationCap != null) args.push('-t', String(preset.durationCap));
  args.push(
    '-an', // sem áudio: bg/hero em loop não precisam de trilha
    ...codecArgs,
    '-pix_fmt', 'yuv420p',
  );

  if (kind === 'mp4') args.push('-movflags', '+faststart');
  args.push(output);
  return args;
}
