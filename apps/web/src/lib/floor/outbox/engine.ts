import type {
  ArgsInput,
  CallRpc,
  OutboxApi,
  OutboxCommand,
  OutboxState,
  OutboxStore,
  RejectedCommand,
  SettledEvent,
  SubmitResult,
} from './types';

export interface BackoffOptions {
  baseMs: number;
  factor: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1000, factor: 2, maxMs: 60_000 };

/** Delay before retry number `failures` (1 = first failure). */
export function backoffDelay(failures: number, options: BackoffOptions = DEFAULT_BACKOFF): number {
  if (failures <= 0) return 0;
  return Math.min(options.maxMs, options.baseMs * Math.pow(options.factor, failures - 1));
}

export interface OutboxOptions {
  store: OutboxStore;
  callRpc: CallRpc;
  isOnline?: () => boolean;
  now?: () => Date;
  randomUuid?: () => string;
  backoff?: Partial<BackoffOptions>;
  /** Timer injection for tests; returns a cancel function. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Runs the drain under a cross-tab lock when the browser offers one. */
  withLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

const INITIAL_STATE: OutboxState = {
  queued: 0,
  rejected: 0,
  draining: false,
  online: true,
  lastError: null,
  needsAuth: false,
  nextRetryAt: null,
  ready: false,
};

/**
 * Replays queued commands strictly in order.
 *   ok         remove and go on
 *   business   move to the rejected list (shown to the operator) and go on
 *   transient  keep at the head, stop, retry with exponential backoff
 * A command is never skipped because of a transient error, so order holds.
 */
export class Outbox implements OutboxApi {
  private readonly store: OutboxStore;
  private readonly callRpc: CallRpc;
  private readonly isOnline: () => boolean;
  private readonly now: () => Date;
  private readonly randomUuid: () => string;
  private readonly backoff: BackoffOptions;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly withLock: <T>(fn: () => Promise<T>) => Promise<T>;

  private state: OutboxState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly settledListeners = new Set<(event: SettledEvent) => void>();
  private draining: Promise<void> | null = null;
  private rerun = false;
  private failures = 0;
  private cancelRetry: (() => void) | null = null;
  private stopListening: (() => void) | null = null;

  constructor(options: OutboxOptions) {
    this.store = options.store;
    this.callRpc = options.callRpc;
    this.isOnline = options.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine));
    this.now = options.now ?? (() => new Date());
    this.randomUuid = options.randomUuid ?? (() => crypto.randomUUID());
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.schedule =
      options.schedule ??
      ((fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      });
    this.withLock = options.withLock ?? ((fn) => fn());
  }

  // ---- state ---------------------------------------------------------------

  getState = (): OutboxState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  onSettled(listener: (event: SettledEvent) => void): () => void {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  private setState(patch: Partial<OutboxState>): void {
    const next = { ...this.state, ...patch };
    const changed = (Object.keys(next) as (keyof OutboxState)[]).some((k) => next[k] !== this.state[k]);
    if (!changed) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private async refreshCounts(): Promise<void> {
    const [queued, rejected] = await Promise.all([this.store.count(), this.store.countUnacknowledgedRejected()]);
    this.setState({ queued, rejected, ready: true, online: this.isOnline() });
  }

  // ---- lifecycle -----------------------------------------------------------

  /** Read counts, listen for connectivity changes and start replaying. */
  start(): void {
    if (this.stopListening) return;
    const kick = () => {
      this.setState({ online: this.isOnline() });
      void this.drain();
    };
    const offline = () => this.setState({ online: false });
    const visible = () => {
      if (document.visibilityState === 'visible') kick();
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('online', kick);
      window.addEventListener('offline', offline);
      document.addEventListener('visibilitychange', visible);
      this.stopListening = () => {
        window.removeEventListener('online', kick);
        window.removeEventListener('offline', offline);
        document.removeEventListener('visibilitychange', visible);
      };
    } else {
      this.stopListening = () => {};
    }
    void this.refreshCounts().then(() => this.drain());
  }

  stop(): void {
    this.stopListening?.();
    this.stopListening = null;
    this.cancelRetry?.();
    this.cancelRetry = null;
  }

  // ---- queueing ------------------------------------------------------------

  async enqueue(rpc: string, args: ArgsInput, opts: { event_at?: string } = {}): Promise<OutboxCommand> {
    const created_at = this.now().toISOString();
    const meta = { client_uuid: this.randomUuid(), created_at, event_at: opts.event_at ?? created_at };
    const resolved = typeof args === 'function' ? args(meta) : args;
    const command = await this.store.add({ ...meta, rpc, args: resolved, attempts: 0, last_error: null });
    await this.refreshCounts();
    return command;
  }

  async submit(rpc: string, args: ArgsInput, opts: { event_at?: string; waitMs?: number } = {}): Promise<SubmitResult> {
    const command = await this.enqueue(rpc, args, opts);
    const client_uuid = command.client_uuid;
    return new Promise<SubmitResult>((resolve) => {
      let finished = false;
      const finish = (result: SubmitResult) => {
        if (finished) return;
        finished = true;
        off();
        cancelTimer();
        resolve(result);
      };
      const off = this.onSettled((event) => {
        if (event.command.client_uuid !== client_uuid) return;
        if (event.status === 'done') finish({ status: 'done', client_uuid, data: event.data });
        else finish({ status: 'rejected', client_uuid, code: event.code, message: event.message });
      });
      const cancelTimer = this.schedule(() => finish({ status: 'queued', client_uuid }), opts.waitMs ?? 4000);
      void this.drain().then(() => {
        // Offline or backing off: the command stays queued.
        if (!this.isOnline() || this.state.nextRetryAt !== null) finish({ status: 'queued', client_uuid });
      });
    });
  }

  // ---- replay --------------------------------------------------------------

  /** Replay the queue. Concurrent calls share one run; a call during a run triggers one more pass. */
  drain(): Promise<void> {
    if (this.draining) {
      this.rerun = true;
      return this.draining;
    }
    this.draining = (async () => {
      try {
        do {
          this.rerun = false;
          await this.withLock(() => this.drainOnce());
        } while (this.rerun);
      } finally {
        this.draining = null;
        this.setState({ draining: false });
      }
    })();
    return this.draining;
  }

  private async drainOnce(): Promise<void> {
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.setState({ nextRetryAt: null });

    for (;;) {
      if (!this.isOnline()) {
        this.setState({ online: false, draining: false });
        await this.refreshCounts();
        return;
      }
      const command = await this.store.peek();
      if (!command) {
        this.failures = 0;
        this.setState({ lastError: null, needsAuth: false });
        await this.refreshCounts();
        return;
      }
      this.setState({ draining: true, online: true });

      let outcome: Awaited<ReturnType<CallRpc>>;
      try {
        outcome = await this.callRpc(command.rpc, command.args, command);
      } catch (err) {
        outcome = { ok: false, kind: 'transient', message: err instanceof Error ? err.message : String(err) };
      }

      if (outcome.ok) {
        await this.store.remove(command.seq);
        this.failures = 0;
        this.setState({ lastError: null, needsAuth: false });
        await this.refreshCounts();
        this.emitSettled({ status: 'done', command, data: outcome.data });
        continue;
      }

      if (outcome.kind === 'business') {
        await this.store.reject(command, {
          code: outcome.code,
          message: outcome.message,
          rejected_at: this.now().toISOString(),
        });
        this.failures = 0;
        await this.refreshCounts();
        this.emitSettled({ status: 'rejected', command, code: outcome.code, message: outcome.message });
        continue;
      }

      // Transient: keep the command at the head and retry later.
      this.failures += 1;
      await this.store.update({ ...command, attempts: command.attempts + 1, last_error: outcome.message });
      const delay = backoffDelay(this.failures, this.backoff);
      this.cancelRetry = this.schedule(() => {
        this.cancelRetry = null;
        void this.drain();
      }, delay);
      this.setState({
        lastError: outcome.message,
        needsAuth: outcome.auth === true,
        nextRetryAt: this.now().getTime() + delay,
        draining: false,
      });
      await this.refreshCounts();
      return;
    }
  }

  private emitSettled(event: SettledEvent): void {
    for (const listener of this.settledListeners) listener(event);
  }

  // ---- lists ---------------------------------------------------------------

  listQueued(): Promise<OutboxCommand[]> {
    return this.store.listQueued();
  }

  listRejected(): Promise<RejectedCommand[]> {
    return this.store.listRejected();
  }

  async acknowledgeRejected(client_uuid: string): Promise<void> {
    await this.store.acknowledgeRejected(client_uuid, this.now().toISOString());
    await this.refreshCounts();
  }
}

/** Cross-tab lock so two tabs never replay the same queue at the same time. */
export function webLock(name = 'dayson-floor-outbox'): <T>(fn: () => Promise<T>) => Promise<T> {
  return async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (typeof navigator === 'undefined' || !navigator.locks) return fn();
    return navigator.locks.request(name, () => fn()) as Promise<T>;
  };
}
