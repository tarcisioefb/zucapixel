/**
 * slugify.ts — Nomes de arquivo seguros para WordPress/Elementor.
 *
 * Por que isso importa: WP gera `-scaled` e quebra URLs quando o nome
 * tem espaço, maiúscula ou acento. Padronizamos tudo em
 * `lowercase-com-hifen` para URLs estáveis e cache previsível.
 */

const MAX_SLUG_LEN = 80;

/** Mapa extra p/ caracteres que o NFD não decompõe sozinho. */
const EXTRA_MAP: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ñ: 'n',
  ç: 'c',
  ø: 'o',
  å: 'a',
  Ł: 'l',
  ł: 'l',
  Ð: 'd',
  ð: 'd',
  þ: 'th',
};

/**
 * Converte qualquer nome em slug seguro:
 * sem acento, lowercase, hífen como separador, máx. 80 chars.
 *
 * @example
 * slugify('Hero Agência São Paulo_FINAL.png') // 'hero-agencia-sao-paulo-final-png'
 * slugify('  --Logo@Topo 2024!! ')            // 'logo-topo-2024'
 */
export function slugify(name: string): string {
  if (typeof name !== 'string') return '';

  let s = name.normalize('NFD').replace(/[̀-ͯ]/g, '');

  // Aplica mapa extra (ß, æ, ç isolado etc.)
  s = s
    .split('')
    .map((ch) => EXTRA_MAP[ch] ?? ch)
    .join('');

  s = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // tudo que não é alfanumérico vira hífen
    .replace(/^-+|-+$/g, '') // apara hífens das bordas
    .replace(/-{2,}/g, '-'); // colapsa hífens duplos

  if (s.length > MAX_SLUG_LEN) {
    s = s.slice(0, MAX_SLUG_LEN).replace(/-+$/g, '');
  }
  return s || 'arquivo';
}

/** Remove a extensão do nome (`hero.png` → `hero`). */
function stripExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  // Ignora dotfiles (`.htaccess`) e nomes sem extensão real
  if (idx <= 0) return filename;
  return filename.slice(0, idx);
}

/** Normaliza o formato para extensão de arquivo (`jpeg` → `jpg`). */
function formatToExt(format: string): string {
  const f = format.toLowerCase().replace(/^\./, '');
  if (f === 'jpeg') return 'jpg';
  return f;
}

/**
 * Monta o nome do arquivo de saída no padrão do projeto:
 * `<slug>-<largura>w.<ext>` — ex.: `hero-agencia-1920w.webp`.
 *
 * Quando `width` é `null` (ex.: logo sem resize), usa o preset:
 * `<slug>-<presetId>.<ext>` — ex.: `logo-cliente-logo-lossless.webp`.
 */
export function buildOutputName(
  original: string,
  presetId: string,
  width: number | null,
  format: string,
): string {
  const base = slugify(stripExtension(original.trim()));
  const ext = formatToExt(format);
  const preset = slugify(presetId);

  if (width === null || width === undefined) return `${base}-${preset}.${ext}`;
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error(`width inválido em buildOutputName: ${String(width)}`);
  }
  return `${base}-${width}w.${ext}`;
}

export interface ParsedDimensions {
  width: number;
  /** `null` quando a string só informa largura (`800w`). */
  height: number | null;
  raw: string;
}

/**
 * Extrai dimensões de strings comuns (`1920x1080`, `1920 x 1080`,
 * `800w`, `800W`). Retorna `null` se não reconhecer.
 *
 * @example
 * parseDimensions('1920x1080') // { width: 1920, height: 1080, ... }
 * parseDimensions('800w')       // { width: 800, height: null, ... }
 */
export function parseDimensions(input: string): ParsedDimensions | null {
  if (typeof input !== 'string') return null;
  const raw = input;
  const s = input.trim().toLowerCase().replace(/\s+/g, '');

  // "1920x1080" (com ou sem espaços — já removidos acima)
  const wh = s.match(/^(\d{1,5})x(\d{1,5})$/);
  if (wh) {
    const width = Number(wh[1]);
    const height = Number(wh[2]);
    if (width > 0 && height > 0) return { width, height, raw };
    return null;
  }

  // "800w" — só largura
  const w = s.match(/^(\d{1,5})w$/);
  if (w) {
    const width = Number(w[1]);
    if (width > 0) return { width, height: null, raw };
  }

  return null;
}
