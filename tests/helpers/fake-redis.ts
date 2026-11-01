import type { RateLimitRedisClient } from '../../src/services/cache/rate-limit-store';

interface Entry {
  hits: number;
  expiresAt: number;
}

/**
 * Minimal Redis double for the rate-limit store.
 *
 * It implements the single Lua increment operation and the decrement/delete
 * commands the store uses. Tests can share one instance between limiter
 * instances to prove that the counter is not process-local, and can mark the
 * connection unavailable to exercise the fail-closed policy.
 */
export class FakeRedisClient implements RateLimitRedisClient {
  isOpen = true;
  isReady = true;

  private readonly entries = new Map<string, Entry>();
  private clock = Date.now();
  private failure: Error | null = null;

  setAvailable(available: boolean): void {
    this.isOpen = available;
    this.isReady = available;
  }

  failWith(error: Error): void {
    this.failure = error;
  }

  clearFailure(): void {
    this.failure = null;
  }

  advance(ms: number): void {
    this.clock += ms;
    this.pruneExpired();
  }

  value(key: string): number | undefined {
    const entry = this.entries.get(key);

    if (!entry || entry.expiresAt <= this.clock) {
      return undefined;
    }

    return entry.hits;
  }

  async eval(_script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    this.assertAvailable();

    const key = options.keys[0];

    if (!key) {
      throw new Error('The rate-limit store received no key');
    }

    const ttlMs = Number(options.arguments[0]);
    const existing = this.entries.get(key);
    const current = existing && existing.expiresAt > this.clock ? existing.hits + 1 : 1;
    const expiresAt =
      existing && existing.expiresAt > this.clock ? existing.expiresAt : this.clock + ttlMs;

    this.entries.set(key, { hits: current, expiresAt });

    return [current, Math.max(expiresAt - this.clock, 0)];
  }

  async decr(key: string): Promise<number> {
    this.assertAvailable();

    const existing = this.entries.get(key);

    if (!existing || existing.expiresAt <= this.clock) {
      return 0;
    }

    existing.hits = Math.max(0, existing.hits - 1);

    return existing.hits;
  }

  async del(key: string): Promise<number> {
    this.assertAvailable();

    return this.entries.delete(key) ? 1 : 0;
  }

  private assertAvailable(): void {
    if (!this.isOpen || !this.isReady) {
      throw this.failure ?? new Error('Redis is unavailable');
    }

    if (this.failure) {
      throw this.failure;
    }
  }

  private pruneExpired(): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= this.clock) {
        this.entries.delete(key);
      }
    }
  }
}
