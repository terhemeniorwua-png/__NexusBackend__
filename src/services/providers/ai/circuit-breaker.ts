/**
 * Small dependency-free circuit breaker for optional external services.
 *
 * The AI service is not on the critical path. When it starts failing, the
 * breaker stops hammering it for a cooldown period so that AI requests fail
 * fast instead of consuming the API process' sockets and event-loop time.
 */
export type CircuitState = 'closed' | 'open' | 'half_open';

export class CircuitBreaker {
  private failures = 0;
  private openedAtMs = 0;
  private state: CircuitState = 'closed';

  constructor(
    private readonly failureThreshold: number,
    private readonly resetMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get currentState(): CircuitState {
    this.refresh();
    return this.state;
  }

  allowRequest(): boolean {
    this.refresh();
    return this.state !== 'open';
  }

  onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
    this.openedAtMs = 0;
  }

  onFailure(): void {
    this.failures += 1;

    if (this.state === 'half_open' || this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAtMs = this.now();
      this.failures = 0;
    }
  }

  private refresh(): void {
    if (this.state === 'open' && this.now() - this.openedAtMs >= this.resetMs) {
      this.state = 'half_open';
    }
  }
}
