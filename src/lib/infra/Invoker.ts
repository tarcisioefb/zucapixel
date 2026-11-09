/**
 * Invoker.ts — Abstração do executor ffmpeg (Desktop vs. Server).
 *
 * Por que existe: o core (`convert/`) não pode importar Tauri nem
 * `fetch` direto — ele recebe um `Invoker`. Isso mantém os Jobs
 * testáveis (mock) e permite o futuro webapp sem reescrever a fila.
 *
 * - Desktop (Tauri): spawna o sidecar `ffmpeg` via
 *   `@tauri-apps/plugin-shell` e parseia `-progress pipe:1`.
 * - Server (futuro webapp): stub que chama `POST /api/convert`.
 */

export interface RunFfmpegOptions {
  /** Duração total (s) p/ converter `out_time_ms` em %. Sem isso, emite marcos. */
  durationSec?: number;
  /** Sinal de cancelamento (futuro: mata o processo). */
  signal?: AbortSignal;
}

export interface Invoker {
  /**
   * Executa ffmpeg com os args dados.
   * `onProgress` recebe 0–100. Deve rejeitar com Error em falha.
   */
  runFfmpeg(args: string[], onProgress: (p: number) => void, opts?: RunFfmpegOptions): Promise<void>;
}

// ---------------------------------------------------------------------------
// Desktop — Tauri sidecar
// ---------------------------------------------------------------------------

/** Converte `out_time_ms=1234567` (ou `out_time_us`) em segundos. */
function parseOutTimeSec(line: string): number | null {
  const ms = line.match(/out_time_ms=(\d+)/);
  if (ms) return Number(ms[1]) / 1_000_000;
  const us = line.match(/out_time_us=(\d+)/);
  if (us) return Number(us[1]) / 1_000_000;
  // Formato legado `time=00:00:03.50`
  const t = line.match(/time=(\d+):(\d+):([\d.]+)/);
  if (t) return Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
  return null;
}

/**
 * Formato mínimo do sidecar que usamos (evita depender dos tipos do
 * plugin em build web — o import real é dinâmico + `@ts-ignore`).
 */
interface SidecarCommand {
  stdout: { on(event: 'data', cb: (line: string) => void): void };
  execute(): Promise<{ code: number; stdout: string; stderr: string }>;
}

interface TauriShell {
  Command: { sidecar(path: string, args: string[]): SidecarCommand };
}

/**
 * Invoker desktop: usa o sidecar `ffmpeg` do Tauri.
 * Exige `@tauri-apps/plugin-shell` (import dinâmico — não quebra o build web).
 *
 * O chamador deve incluir `-progress pipe:1 -nostats` nos args para
 * progresso granular; sem `durationSec`, emitimos marcos (0 → 90 → 100).
 */
export class DesktopInvoker implements Invoker {
  async runFfmpeg(args: string[], onProgress: (p: number) => void, opts?: RunFfmpegOptions): Promise<void> {
    if (opts?.signal?.aborted) throw new Error('Conversão cancelada.');

    let shell: TauriShell;
    try {
      // @ts-ignore — módulo só existe com o plugin Tauri instalado; falha vira erro amigável abaixo
      shell = (await import('@tauri-apps/plugin-shell')) as unknown as TauriShell;
    } catch {
      throw new Error(
        'Plugin Tauri Shell ausente — adicione `@tauri-apps/plugin-shell` e registre o sidecar `ffmpeg` (tauri.conf.json > bundle > externalBin).',
      );
    }

    const command = shell.Command.sidecar('binaries/ffmpeg', args);
    onProgress(0);

    // Acumula stdout por linhas — ffmpeg `-progress pipe:1` cospe `k=v`
    let buf = '';
    const total = opts?.durationSec && opts.durationSec > 0 ? opts.durationSec : null;
    let lastEmitted = 0;

    command.stdout.on('data', (raw: string) => {
      buf += raw;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (t === 'progress=end') {
          onProgress(100);
          return;
        }
        const sec = parseOutTimeSec(t);
        if (sec != null) {
          if (total) {
            const pct = Math.min(99, (sec / total) * 100);
            if (pct > lastEmitted) {
              lastEmitted = pct;
              onProgress(pct);
            }
          } else if (lastEmitted < 90) {
            // Sem duração: avança em marcos para não travar a barra em 0
            lastEmitted = Math.min(90, lastEmitted + 5);
            onProgress(lastEmitted);
          }
        }
      }
    });

    const output = await command.execute();

    if (output.code !== 0) {
      const detail = (output.stderr || output.stdout || '').slice(-500);
      throw new Error(`ffmpeg falhou (exit ${output.code}): ${detail}`);
    }
    onProgress(100);
  }
}

// ---------------------------------------------------------------------------
// Server — stub p/ futuro webapp
// ---------------------------------------------------------------------------

export interface ServerInvokerOptions {
  endpoint?: string;
}

/**
 * Stub: envia os args p/ `POST /api/convert` (SSE de progresso).
 * O backend ainda não existe — falha com mensagem clara até lá.
 */
export class ServerInvoker implements Invoker {
  private readonly endpoint: string;

  constructor(opts: ServerInvokerOptions = {}) {
    this.endpoint = opts.endpoint ?? '/api/convert';
  }

  async runFfmpeg(args: string[], onProgress: (p: number) => void): Promise<void> {
    onProgress(0);
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args }),
    }).catch(() => null);

    if (!res || !res.ok) {
      throw new Error(
        `Backend de conversão indisponível (${this.endpoint}). ` +
          'Este stub será ligado quando o webapp/server existir — no desktop, use DesktopInvoker.',
      );
    }
    // TODO(webapp): consumir SSE `data: {"progress": n}` aqui.
    onProgress(100);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Detecta runtime Tauri sem quebrar SSR/testes. */
function isTauriRuntime(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      ('__TAURI__' in window || '__TAURI_INTERNALS__' in window)
    );
  } catch {
    return false;
  }
}

let cached: Invoker | null = null;

/**
 * Retorna o Invoker adequado (singleton):
 * Tauri → `DesktopInvoker`, browser/server → `ServerInvoker`.
 */
export function getInvoker(): Invoker {
  if (!cached) {
    cached = isTauriRuntime() ? new DesktopInvoker() : new ServerInvoker();
  }
  return cached;
}

/** Limpa o singleton (útil em testes). */
export function resetInvoker(): void {
  cached = null;
}
