import { AppError } from '../../utils/errors';

/**
 * Process-local worker health registry.
 *
 * Every background worker runs inside the API process and coordinates through
 * a durable PostgreSQL queue. The registry records liveness only: when a pass
 * starts, when it finishes, and whether it failed. It never stores job
 * payloads or error messages, so the public health response cannot leak
 * business data.
 *
 * Liveness is intentionally process-local. With several API instances, each
 * instance reports its own workers; a load balancer probes each instance.
 */

export type WorkerHealthState = 'IDLE' | 'RUNNING' | 'FAILING' | 'STOPPED';

export interface WorkerHealthRecorder {
  /** The worker loop has been started. */
  started(): void;
  /** A pass is beginning. */
  passStarted(): void;
  /** A pass completed successfully. */
  succeeded(): void;
  /** A pass failed. Only a stable error code is retained. */
  failed(error: unknown): void;
  stopped(): void;
}

export interface WorkerHealthEntry {
  name: string;
  state: WorkerHealthState;
  started: boolean;
  stale: boolean;
  consecutiveFailures: number;
  lastPassStartedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorCode: string | null;
}

export interface WorkerHealthReport {
  status: 'ok' | 'degraded';
  checkedAt: string;
  staleAfterMs: number;
  workers: WorkerHealthEntry[];
}

export interface WorkerHealthRegistryOptions {
  /** A running worker with no successful pass for this long is stale. */
  staleAfterMs: number;
  /** Consecutive failed passes before a worker is considered failing. */
  failureThreshold?: number;
}

export interface WorkerHealthRegistry {
  register(name: string): WorkerHealthRecorder;
  has(name: string): boolean;
  snapshot(now?: Date): WorkerHealthReport;
}

interface WorkerState {
  name: string;
  startedAt: Date | null;
  stoppedAt: Date | null;
  passStartedAt: Date | null;
  passCompletedAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastErrorCode: string | null;
  consecutiveFailures: number;
  running: boolean;
  started: boolean;
}

const DEFAULT_FAILURE_THRESHOLD = 3;

function errorCode(error: unknown): string {
  if (error instanceof AppError) {
    return error.code;
  }

  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; name?: unknown };

    if (typeof candidate.code === 'string' && candidate.code.length > 0) {
      return candidate.code;
    }

    if (typeof candidate.name === 'string' && candidate.name !== 'Error') {
      return candidate.name;
    }
  }

  return 'WORKER_ERROR';
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function createWorkerHealthRegistry({
  staleAfterMs,
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
}: WorkerHealthRegistryOptions): WorkerHealthRegistry {
  const workers = new Map<string, WorkerState>();

  function createState(name: string): WorkerState {
    return {
      name,
      startedAt: null,
      stoppedAt: null,
      passStartedAt: null,
      passCompletedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastErrorCode: null,
      consecutiveFailures: 0,
      running: false,
      started: false,
    };
  }

  function getOrCreate(name: string): WorkerState {
    const existing = workers.get(name);

    if (existing) {
      return existing;
    }

    const state = createState(name);
    workers.set(name, state);
    return state;
  }

  function recorderFor(name: string): WorkerHealthRecorder {
    const state = getOrCreate(name);

    return {
      started() {
        state.started = true;
        state.startedAt = new Date();
        state.stoppedAt = null;
      },
      passStarted() {
        state.running = true;
        state.passStartedAt = new Date();
      },
      succeeded() {
        const now = new Date();
        state.running = false;
        state.passCompletedAt = now;
        state.lastSuccessAt = now;
        state.consecutiveFailures = 0;
        state.lastErrorCode = null;
      },
      failed(error: unknown) {
        const now = new Date();
        state.running = false;
        state.passCompletedAt = now;
        state.lastFailureAt = now;
        state.lastErrorCode = errorCode(error);
        state.consecutiveFailures += 1;
      },
      stopped() {
        state.started = false;
        state.stoppedAt = new Date();
        state.running = false;
      },
    };
  }

  function snapshot(now: Date = new Date()): WorkerHealthReport {
    const entries: WorkerHealthEntry[] = [];

    for (const state of workers.values()) {
      const reference = state.lastSuccessAt ?? state.startedAt;
      const stale =
        state.started && reference !== null && now.getTime() - reference.getTime() > staleAfterMs;

      let workerState: WorkerHealthState;

      if (!state.started) {
        workerState = 'STOPPED';
      } else if (state.consecutiveFailures >= failureThreshold) {
        workerState = 'FAILING';
      } else if (state.running) {
        workerState = 'RUNNING';
      } else {
        workerState = 'IDLE';
      }

      entries.push({
        name: state.name,
        state: workerState,
        started: state.started,
        stale,
        consecutiveFailures: state.consecutiveFailures,
        lastPassStartedAt: toIso(state.passStartedAt),
        lastSuccessAt: toIso(state.lastSuccessAt),
        lastFailureAt: toIso(state.lastFailureAt),
        lastErrorCode: state.lastErrorCode,
      });
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));

    const degraded = entries.some(
      (entry) => entry.state === 'FAILING' || (entry.started && entry.stale),
    );

    return {
      status: degraded ? 'degraded' : 'ok',
      checkedAt: now.toISOString(),
      staleAfterMs,
      workers: entries,
    };
  }

  return {
    register: recorderFor,
    has: (name: string) => workers.has(name),
    snapshot,
  };
}
