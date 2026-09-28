const RECONCILE_DEBOUNCE_MS = 5000;
// A CLI can persist a generated title well after its output went idle.
const RECONCILE_RETRY_MS = 5000;
const RECONCILE_MAX_RETRIES = 3;
// Caps how far a continuously redrawing CLI pushes the debounce while session or title is unknown.
const RECONCILE_MAX_WAIT_MS = 10000;

/** What a scheduler runs on, handed in by the session manager. */
export interface ReconcileTarget {
  /** One re-listing of the agent's sessions. */
  reconcile(): Promise<void>;
  /** Whether a tab of the agent still waits for its session or title. */
  titlesUnsettled(): boolean;
  /** Closed: a reconcile in flight at close must not re-arm. */
  disposed(): boolean;
}

/**
 * When one agent's sessions of a repository or worktree are re-listed: debounced after output and
 * watcher events, retried while a title may still be persisted late, and never two at once.
 */
export class ReconcileScheduler {
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private retriesLeft = 0;
  /** The latest the debounced reconcile may be pushed to; unset once it fires. */
  private deadline?: number;

  constructor(private readonly target: ReconcileTarget) {}

  schedule(delayMs = RECONCILE_DEBOUNCE_MS): void {
    // Only an unsettled label caps the debounce and retries (a title persisted late); otherwise
    // listings stay out of a turn.
    const unsettled = this.target.titlesUnsettled();
    this.retriesLeft = unsettled ? RECONCILE_MAX_RETRIES : 0;
    if (unsettled && this.deadline === undefined) {
      this.deadline = Date.now() + RECONCILE_MAX_WAIT_MS;
    }
    this.arm(delayMs);
  }

  /** Re-lists now. Serialized: a call while one is in flight joins it. */
  run(): Promise<void> {
    this.running ??= this.target.reconcile().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** The reconcile in flight, if any. */
  get inFlight(): Promise<void> | undefined {
    return this.running;
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  private arm(delayMs: number): void {
    // The retry re-arms after every run; a reconcile in flight at close must not re-arm.
    if (this.target.disposed()) {
      return;
    }
    clearTimeout(this.timer);
    const cappedDelay = this.deadline === undefined ? delayMs : Math.min(delayMs, Math.max(0, this.deadline - Date.now()));
    this.timer = setTimeout(() => {
      this.deadline = undefined;
      void this.run().then(() => {
        if (this.retriesLeft > 0 && this.target.titlesUnsettled()) {
          this.retriesLeft -= 1;
          this.arm(RECONCILE_RETRY_MS);
        }
      });
    }, cappedDelay);
  }
}
