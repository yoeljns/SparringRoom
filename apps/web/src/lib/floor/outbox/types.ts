/**
 * Offline outbox (spec section 2 "Offline", 5.7, 13.1).
 * Scan commands are queued in IndexedDB and replayed strictly in order.
 * Each command carries a client_uuid; the server treats a repeated
 * client_uuid as already done, so a replay after a lost response is safe.
 */
import type { RpcOutcome } from '@/lib/data/rpc';

export interface OutboxCommand {
  /** Queue position, assigned by IndexedDB (auto-increment). */
  seq: number;
  client_uuid: string;
  rpc: string;
  args: Record<string, unknown>;
  /** When the command was queued (ISO). */
  created_at: string;
  /** When the physical event happened (ISO); equals created_at unless given. */
  event_at: string;
  attempts: number;
  last_error: string | null;
}

export interface RejectedCommand extends OutboxCommand {
  rejected_at: string;
  error_code: string;
  error_message: string;
  /** Set when the operator has seen it. */
  acknowledged_at: string | null;
}

export interface CommandMeta {
  client_uuid: string;
  event_at: string;
  created_at: string;
}

/** Args, or a builder that places client_uuid / event_at where the RPC expects them. */
export type ArgsInput = Record<string, unknown> | ((meta: CommandMeta) => Record<string, unknown>);

/** Injected transport; the engine never talks to Supabase itself. */
export type CallRpc = (rpc: string, args: Record<string, unknown>, command: OutboxCommand) => Promise<RpcOutcome>;

export interface OutboxState {
  /** Commands waiting to be sent. */
  queued: number;
  /** Rejected commands the operator has not acknowledged yet. */
  rejected: number;
  draining: boolean;
  online: boolean;
  /** Last transient error, cleared on the next success. */
  lastError: string | null;
  /** True when the last transient error was an expired session. */
  needsAuth: boolean;
  /** Epoch ms of the next automatic retry, or null. */
  nextRetryAt: number | null;
  /** False until the first read of IndexedDB has finished. */
  ready: boolean;
}

export type SubmitResult =
  | { status: 'done'; client_uuid: string; data: unknown }
  | { status: 'queued'; client_uuid: string }
  | { status: 'rejected'; client_uuid: string; code: string; message: string };

export type SettledEvent =
  | { status: 'done'; command: OutboxCommand; data: unknown }
  | { status: 'rejected'; command: OutboxCommand; code: string; message: string };

export interface OutboxApi {
  enqueue(rpc: string, args: ArgsInput, opts?: { event_at?: string }): Promise<OutboxCommand>;
  /** Queue, try to send at once, and wait briefly for the server's answer. */
  submit(rpc: string, args: ArgsInput, opts?: { event_at?: string; waitMs?: number }): Promise<SubmitResult>;
  drain(): Promise<void>;
  listQueued(): Promise<OutboxCommand[]>;
  listRejected(): Promise<RejectedCommand[]>;
  acknowledgeRejected(client_uuid: string): Promise<void>;
}

/** Persistence used by the engine; implemented on IndexedDB. */
export interface OutboxStore {
  add(command: Omit<OutboxCommand, 'seq'>): Promise<OutboxCommand>;
  /** The oldest queued command, or null. */
  peek(): Promise<OutboxCommand | null>;
  update(command: OutboxCommand): Promise<void>;
  remove(seq: number): Promise<void>;
  /** Atomically move a command from the queue to the rejected list. */
  reject(command: OutboxCommand, info: { code: string; message: string; rejected_at: string }): Promise<void>;
  count(): Promise<number>;
  countUnacknowledgedRejected(): Promise<number>;
  listQueued(): Promise<OutboxCommand[]>;
  listRejected(): Promise<RejectedCommand[]>;
  acknowledgeRejected(client_uuid: string, at: string): Promise<void>;
}
