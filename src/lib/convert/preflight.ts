/**
 * preflight.ts — Validação ANTES da conversão (fail-fast).
 *
 * Filosofia: avisar em segundos em vez de converter por minutos um
 * arquivo que o WordPress/Elementor vai rejeitar ou exibir mal.
 * `error` bloqueia a fila; `warn` deixa o usuário decidir.
 */

export type PreflightLevel = 'error' | 'warn' | 'ok';

export interface PreflightIssue {
  level: PreflightLevel;
  /** Código estável p/ i18n e testes (ex.: 'IMAGE_TOO_HEAVY'). */
  code: string;
  message: string;
}

// Limites (bytes p/ evitar float de KB)
const KB = 1024;
const MB = 1024 * 1024;
const IMAGE_HARD_LIMIT = 5 * MB; // >5MB = error, sempre
const COMPRESS_WARN_LIMIT = 300 * KB; // compress: acima disso vira warn "boa candidata"
const HERO_WARN_LIMIT = 150 * KB; // hero >150KB = warn
const VIDEO_HARD_LIMIT = 12 * MB; // >12MB = error
const HERO_VIDEO_WARN = 2 * MB; // hero >2MB = warn
const WP_SCALED_LIMIT = 2560; // WP gera -scaled acima de 2560px
const VIDEOS_LONG_WARN_SEC = 10;

export interface CheckImageParams {
  sizeBytes: number;
  /** Largura ORIGINAL do arquivo (px). */
  width: number;
  /** Largura ALVO do preset — p/ detectar upscale. */
  targetWidth?: number | null;
  /** Texto alternativo (acessibilidade/SEO). */
  alt?: string;
  /** Nome do arquivo original (p/ checar hero + caracteres). */
  name?: string;
  /** Força tratamento como hero mesmo sem "hero" no nome. */
  isHero?: boolean;
  /** `true` quando o preset é compress-only (estilo iLoveIMG): entrada pesada é esperada. */
  isCompress?: boolean;
}

export interface CheckVideoParams {
  sizeBytes: number;
  durationSec: number;
  name?: string;
  isHero?: boolean;
}

/** Detecta "hero" pelo nome ou flag explícita. */
function isHeroFile(name: string | undefined, isHero: boolean | undefined): boolean {
  if (isHero === true) return true;
  if (!name) return false;
  return name.toLowerCase().includes('hero');
}

/** Acusa espaço, maiúscula ou acento — os 3 quebram URL no WP. */
function findFilenameProblems(name: string): string[] {
  const problems: string[] = [];
  if (/\s/.test(name)) problems.push('espaços');
  if (/[A-Z]/.test(name)) problems.push('letras maiúsculas');
  // Qualquer char fora do ASCII seguro (inclui acentos, ç, emojis)
  if (/[^a-z0-9._\-/\\]/i.test(name.replace(/[a-z0-9._\-/\\ ]/gi, (m) => (/\s/.test(m) ? m : ''))) || /[^\x00-\x7F]/.test(name)) {
    problems.push('acentos/caracteres especiais');
  }
  return problems;
}

/**
 * Valida uma imagem antes de entrar na fila.
 *
 * Regras:
 * - >5MB → error | hero >150KB → warn | compress >300KB → warn (boa candidata)
 * - width >2560 → error (WP -scaled)
 * - espaço/maiúscula/acento no nome → error (um por problema)
 * - sem alt → warn | upscale (origem < alvo) → error
 */
export function checkImage(params: CheckImageParams): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const { sizeBytes, width, targetWidth, alt, name, isHero, isCompress } = params;
  const hero = isHeroFile(name, isHero);

  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    issues.push({ level: 'error', code: 'INVALID_SIZE', message: 'Tamanho do arquivo inválido.' });
    return issues;
  }

  // Modo compress (iLoveIMG): entrada de 2-8MB é o caso de uso, não erro.
  // Só bloqueia acima de 10MB; acima de 300KB vira warn com expectativa de economia.
  // Conversão normal: bloqueia só acima de 5MB (foto de celular/câmera entra direto).
  const hardLimit = isCompress ? 10 * MB : IMAGE_HARD_LIMIT;
  if (sizeBytes > hardLimit) {
    issues.push({
      level: 'error',
      code: 'IMAGE_TOO_HEAVY',
      message: isCompress
        ? `Imagem com ${(sizeBytes / MB).toFixed(1)}MB — acima de 10MB, nem a compressão salva. Redimensione antes.`
        : `Imagem com ${(sizeBytes / MB).toFixed(1)}MB — acima do limite de 5MB. Redimensione ou use o preset Comprimir antes de converter.`,
    });
  } else if (isCompress && sizeBytes > COMPRESS_WARN_LIMIT) {
    issues.push({
      level: 'warn',
      code: 'COMPRESS_EXPECTED_SAVING',
      message: `Imagem com ${(sizeBytes / KB).toFixed(0)}KB — boa candidata à compressão (esperado -40 a -70% em JPG q75, -20 a -50% em PNG).`,
    });
  } else if (hero && sizeBytes > HERO_WARN_LIMIT) {
    issues.push({
      level: 'warn',
      code: 'HERO_HEAVY',
      message: `Hero com ${(sizeBytes / KB).toFixed(0)}KB — ideal abaixo de 150KB para o LCP. Considere trocar o original.`,
    });
  }

  if (!Number.isFinite(width) || width <= 0) {
    issues.push({ level: 'error', code: 'INVALID_WIDTH', message: 'Largura da imagem inválida.' });
  } else {
    if (width > WP_SCALED_LIMIT) {
      issues.push({
        level: 'error',
        code: 'WP_SCALED_RISK',
        message: `Largura de ${width}px — o WordPress vai gerar um "-scaled" acima de 2560px e quebrar a URL. Redimensione o original.`,
      });
    }
    if (targetWidth != null && width < targetWidth) {
      issues.push({
        level: 'error',
        code: 'UPSCALE_DETECTED',
        message: `Upscale: original tem ${width}px mas o alvo é ${targetWidth}px — ampliar gera blur sem ganho. Escolha um preset menor.`,
      });
    }
  }

  if (name) {
    for (const problem of findFilenameProblems(name)) {
      issues.push({
        level: 'error',
        code: 'BAD_FILENAME',
        message: `Nome do arquivo contém ${problem} ("${name}"). Renomeie para minúsculas com hífen antes de subir ao WP.`,
      });
    }
  }

  if (!alt || alt.trim().length === 0) {
    issues.push({
      level: 'warn',
      code: 'MISSING_ALT',
      message: 'Sem texto alternativo (alt) — ruim para acessibilidade e SEO. Adicione antes de publicar.',
    });
  }

  if (issues.length === 0) {
    issues.push({ level: 'ok', code: 'OK', message: 'Pronto para converter.' });
  }
  return issues;
}

/**
 * Valida um vídeo antes de entrar na fila.
 *
 * Regras: >12MB → error | hero >2MB → warn | >10s → warn.
 */
export function checkVideo(params: CheckVideoParams): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const { sizeBytes, durationSec, name, isHero } = params;
  const hero = isHeroFile(name, isHero);

  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    issues.push({ level: 'error', code: 'INVALID_SIZE', message: 'Tamanho do arquivo inválido.' });
    return issues;
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    issues.push({ level: 'error', code: 'INVALID_DURATION', message: 'Duração do vídeo inválida.' });
    return issues;
  }

  if (sizeBytes > VIDEO_HARD_LIMIT) {
    issues.push({
      level: 'error',
      code: 'VIDEO_TOO_HEAVY',
      message: `Vídeo com ${(sizeBytes / MB).toFixed(1)}MB — acima do limite de 12MB. Corte/comprima antes de converter.`,
    });
  } else if (hero && sizeBytes > HERO_VIDEO_WARN) {
    issues.push({
      level: 'warn',
      code: 'HERO_VIDEO_HEAVY',
      message: `Hero em vídeo com ${(sizeBytes / MB).toFixed(1)}MB — ideal abaixo de 2MB para não travar o LCP. Use o preset hero-light.`,
    });
  }

  if (durationSec > VIDEOS_LONG_WARN_SEC) {
    issues.push({
      level: 'warn',
      code: 'VIDEO_TOO_LONG',
      message: `Vídeo com ${durationSec.toFixed(0)}s — acima de 10s pesa a página. Corte para o trecho essencial (a fila limita a ${Math.min(durationSec, 10).toFixed(0)}s).`,
    });
  }

  if (issues.length === 0) {
    issues.push({ level: 'ok', code: 'OK', message: 'Pronto para converter.' });
  }
  return issues;
}

/** `true` se existe ao menos um `error` (deve bloquear a fila). */
export function hasErrors(issues: PreflightIssue[]): boolean {
  return issues.some((i) => i.level === 'error');
}
