/**
 * jobs.ts — Tipos de Job + fila com concorrência limitada.
 *
 * Concorrência (regra do projeto):
 * - Imagem: até 4 em paralelo (ffmpeg webp é leve).
 * - Vídeo: 1 por vez (x264/VP9 saturam a CPU).
 *
 * A fila não conhece ffmpeg/Tauri — recebe um `runner` injetado
 * (ver `src/lib/infra/Invoker.ts`), o que permite testar sem binário
 * e rodar no futuro webapp/server com outro runner.
 */

export type MediaKind = 'image' | 'video';

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface JobInput {
  /** Caminho absoluto do arquivo original. */
  path: string;
  /** Nome do arquivo (p/ slugify + preflight de hero). */
  name: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  /** Segundos (só vídeo). */
  durationSec?: number;
  /** Texto alternativo (só imagem). */
  alt?: string;
}

export interface JobOutput {
  /** Caminho absoluto do arquivo gerado. */
  path: string;
  format: string;
  width?: number | null;
  sizeBytes?: number;
}

export interface Job {
  id: string;
  kind: MediaKind;
  /** Id do preset (`800w`, `hero-light`, …). */
  presetId: string;
  input: JobInput;
  outputs: JobOutput[];
  status: JobStatus;
  /** 0–100 (média dos outputs, ou do encode único). */
  progress: number;
  /** 0–100 — economia vs. original (só após `done`). */
  savedPct?: number;
  error?: string;
  createdAt: number;
}

/** Gera id único sem depender de lib externa. */
function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Cria um Job zerado (`queued`, progresso 0) pronto p/ a fila. */
export function createJob(kind: MediaKind, presetId: string, input: JobInput): Job {
  if (!presetId) throw new Error('presetId é obrigatório.');
  if (!input?.path) throw new Error('JobInput.path é obrigatório.');
  return {
    id: makeId(),
    kind,
    presetId,
    input,
    outputs: [],
    status: 'queued',
    progress: 0,
    createdAt: Date.now(),
  };
}

/**
 * % economizada: `((orig - final) / orig) * 100`, clamp 0–100,
 * 1 casa decimal. Retorna 0 se `originalBytes <= 0`.
 */
export function calcSavedPct(originalBytes: number, resultBytes: number): number {
  if (!Number.isFinite(originalBytes) || originalBytes <= 0) return 0;
  if (!Number.isFinite(resultBytes) || resultBytes < 0) return 0;
  const pct = ((originalBytes - resultBytes) / originalBytes) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Fila
// ---------------------------------------------------------------------------

/** Assinatura do executor real (ffmpeg desktop, API server, mock em teste). */
export type JobRunner = (job: Job, onProgress: (p: number) => void) => Promise<JobOutput[]>;

export interface JobQueueOptions {
  /** Default 4 — imagens são baratas em CPU. */
  imageConcurrency?: number;
  /** Default 1 — vídeo satura a CPU; nunca aumente sem medir. */
  videoConcurrency?: number;
  runner: JobRunner;
}

export type JobListener = (job: Job) => void;

/**
 * Fila simples com 2 "pistas": imagem (4x) e vídeo (1x).
 * Sem dependências — o `runner` é injetado no construtor.
 */
export class JobQueue {
  private readonly imageConcurrency: number;
  private readonly videoConcurrency: number;
  private readonly runner: JobRunner;

  private readonly pending: Job[] = [];
  private runningImages = 0;
  private runningVideos = 0;
  private readonly listeners = new Set<JobListener>();

  constructor(opts: JobQueueOptions) {
    this.imageConcurrency = opts.imageConcurrency ?? 4;
    this.videoConcurrency = opts.videoConcurrency ?? 1;
    this.runner = opts.runner;
  }

  /** Assina atualizações de qualquer job (p/ a UI reagir). Retorna unsubscribe. */
  subscribe(fn: JobListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(job: Job): void {
    for (const fn of this.listeners) fn(job);
  }

  /** Enfileira e tenta despachar imediatamente. */
  enqueue(job: Job): void {
    if (job.status !== 'queued') throw new Error(`Job ${job.id} já saiu da fila (${job.status}).`);
    this.pending.push(job);
    this.emit(job);
    void this.pump();
  }

  /** Marca como cancelado (se ainda na fila) — rodando, o runner decide. */
  cancel(id: string): void {
    const idx = this.pending.findIndex((j) => j.id === id);
    if (idx >= 0) {
      const [job] = this.pending.splice(idx, 1);
      job.status = 'cancelled';
      this.emit(job);
    }
  }

  /** Bomba de despacho: respeita o teto de cada pista. */
  private async pump(): Promise<void> {
    // Tenta despachar enquanto houver slot livre em alguma pista
    const next = this.pending.find(
      (j) =>
        (j.kind === 'image' && this.runningImages < this.imageConcurrency) ||
        (j.kind === 'video' && this.runningVideos < this.videoConcurrency),
    );
    if (!next) return;

    // Remove da fila e ocupa o slot
    this.pending.splice(this.pending.indexOf(next), 1);
    if (next.kind === 'image') this.runningImages += 1;
    else this.runningVideos += 1;

    next.status = 'running';
    this.emit(next);

    try {
      const outputs = await this.runner(next, (p) => {
        next.progress = Math.min(100, Math.max(0, p));
        this.emit(next);
      });
      next.outputs = outputs;
      next.progress = 100;
      next.status = 'done';
      // Economia calculada sobre o menor output (melhor caso p/ a UI)
      const best = outputs.reduce<number | undefined>(
        (min, o) => (o.sizeBytes == null ? min : min == null ? o.sizeBytes : Math.min(min, o.sizeBytes)),
        undefined,
      );
      if (best != null) next.savedPct = calcSavedPct(next.input.sizeBytes, best);
    } catch (err) {
      next.status = 'error';
      next.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (next.kind === 'image') this.runningImages -= 1;
      else this.runningVideos -= 1;
      this.emit(next);
      // Recursão: um slot liberou, pode haver mais fila
      void this.pump();
    }
  }
}
