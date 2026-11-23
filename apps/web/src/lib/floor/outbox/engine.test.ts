import { beforeEach, describe, expect, it } from 'vitest';
import type { RpcOutcome } from '@/lib/data/rpc';
import { Outbox, backoffDelay } from './engine';
import { createIdbOutboxStore } from './store';
import type { OutboxCommand } from './types';

let dbCounter = 0;

interface Harness {
  outbox: Outbox;
  calls: { rpc: string; args: Record<string, unknown>; client_uuid: string }[];
  scheduled: { fn: () => void; ms: number; cancelled: boolean }[];
  setOnline: (value: boolean) => void;
  respond: (handler: (command: OutboxCommand) => RpcOutcome | Promise<RpcOutcome>) => void;
  dbName: string;
}

function harness(dbName = `outbox-test-${++dbCounter}`, uuidPrefix = 'a'): Harness {
  let online = true;
  let handler: (command: OutboxCommand) => RpcOutcome | Promise<RpcOutcome> = () => ({ ok: true, data: null });
  const calls: Harness['calls'] = [];
  const scheduled: Harness['scheduled'] = [];
  let n = 0;
  let clock = Date.parse('2026-11-23T08:00:00Z');
  const outbox = new Outbox({
    store: createIdbOutboxStore(dbName),
    callRpc: async (rpc, args, command) => {
      calls.push({ rpc, args, client_uuid: command.client_uuid });
      return handler(command);
    },
    isOnline: () => online,
    now: () => new Date((clock += 1000)),
    randomUuid: () => `${dbName}-${uuidPrefix}-${++n}`,
    schedule: (fn, ms) => {
      const entry = { fn, ms, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  });
  return {
    outbox,
    calls,
    scheduled,
    dbName,
    setOnline: (value) => {
      online = value;
    },
    respond: (h) => {
      handler = h;
    },
  };
}

const transient: RpcOutcome = { ok: false, kind: 'transient', message: 'Failed to fetch' };

describe('backoffDelay', () => {
  it('doubles up to the cap', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffDelay(n))).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(backoffDelay(0)).toBe(0);
  });
});

describe('Outbox', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('queues while offline and replays strictly in order when online', async () => {
    h.setOnline(false);
    for (let i = 1; i <= 5; i++) await h.outbox.enqueue('post_txn', { n: i });
    await h.outbox.drain();
    expect(h.calls).toEqual([]);
    expect(h.outbox.getState()).toMatchObject({ queued: 5, online: false, ready: true });

    h.setOnline(true);
    await h.outbox.drain();
    expect(h.calls.map((c) => c.args.n)).toEqual([1, 2, 3, 4, 5]);
    expect(h.outbox.getState()).toMatchObject({ queued: 0, rejected: 0, draining: false, lastError: null });
  });

  it('gives every command a client_uuid, created_at and event_at, and lets the caller place them', async () => {
    const a = await h.outbox.enqueue('post_txn', (meta) => ({ txn: { client_uuid: meta.client_uuid, event_at: meta.event_at } }));
    const b = await h.outbox.enqueue('post_txn', { x: 1 }, { event_at: '2026-11-23T07:30:00.000Z' });
    expect(a.client_uuid).not.toBe(b.client_uuid);
    expect(a.args).toEqual({ txn: { client_uuid: a.client_uuid, event_at: a.created_at } });
    expect(a.event_at).toBe(a.created_at);
    expect(b.event_at).toBe('2026-11-23T07:30:00.000Z');
    expect(b.seq).toBeGreaterThan(a.seq);
  });

  it('keeps a command at the head on a transient error and retries with exponential backoff', async () => {
    await h.outbox.enqueue('post_txn', { n: 1 });
    await h.outbox.enqueue('post_txn', { n: 2 });
    h.respond(() => transient);

    await h.outbox.drain();
    expect(h.calls.map((c) => c.args.n)).toEqual([1]); // 2 is not sent before 1
    expect(h.outbox.getState()).toMatchObject({ queued: 2, lastError: 'Failed to fetch' });
    expect(h.outbox.getState().nextRetryAt).not.toBeNull();
    expect(h.scheduled.at(-1)!.ms).toBe(1000);

    // The retry timer fires: the same command is tried again, with a longer delay.
    h.scheduled.at(-1)!.fn();
    await h.outbox.drain();
    expect(h.calls.every((c) => c.args.n === 1)).toBe(true);
    expect(h.calls.length).toBeGreaterThan(1);
    expect(h.scheduled.at(-1)!.ms).toBeGreaterThan(1000);
    const attemptsSoFar = h.calls.length;
    expect((await h.outbox.listQueued())[0]).toMatchObject({ attempts: attemptsSoFar, last_error: 'Failed to fetch' });

    h.respond(() => ({ ok: true, data: null }));
    await h.outbox.drain();
    expect(h.calls.slice(attemptsSoFar).map((c) => c.args.n)).toEqual([1, 2]);
    expect(h.outbox.getState()).toMatchObject({ queued: 0, lastError: null, nextRetryAt: null });
  });

  it('grows the delay on consecutive failures and resets it after a success', async () => {
    await h.outbox.enqueue('post_txn', { n: 1 });
    h.respond(() => transient);
    await h.outbox.drain();
    await h.outbox.drain();
    await h.outbox.drain();
    expect(h.scheduled.map((s) => s.ms)).toEqual([1000, 2000, 4000]);
    // A new drain cancels the pending retry timer, so only one is ever live.
    expect(h.scheduled.map((s) => s.cancelled)).toEqual([true, true, false]);

    h.respond(() => ({ ok: true, data: null }));
    await h.outbox.drain();
    await h.outbox.enqueue('post_txn', { n: 2 });
    h.respond(() => transient);
    await h.outbox.drain();
    expect(h.scheduled.at(-1)!.ms).toBe(1000);
  });

  it('treats a thrown error as transient', async () => {
    await h.outbox.enqueue('post_txn', { n: 1 });
    h.respond(() => {
      throw new Error('socket hang up');
    });
    await h.outbox.drain();
    expect(h.outbox.getState()).toMatchObject({ queued: 1, lastError: 'socket hang up' });
  });

  it('moves a business refusal to the rejected list, does not retry it, and carries on', async () => {
    await h.outbox.enqueue('post_txn', { n: 1 });
    await h.outbox.enqueue('post_txn', { n: 2 });
    await h.outbox.enqueue('post_txn', { n: 3 });
    h.respond((c) =>
      c.args.n === 2 ? { ok: false, kind: 'business', code: 'NEGATIVE_BALANCE', message: 'NEGATIVE_BALANCE: lane TZ-B03-L12' } : { ok: true, data: null },
    );
    await h.outbox.drain();
    expect(h.calls.map((c) => c.args.n)).toEqual([1, 2, 3]);
    expect(h.outbox.getState()).toMatchObject({ queued: 0, rejected: 1 });
    expect(h.scheduled).toEqual([]);

    const rejected = await h.outbox.listRejected();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ args: { n: 2 }, error_code: 'NEGATIVE_BALANCE', acknowledged_at: null });

    await h.outbox.drain();
    expect(h.calls).toHaveLength(3); // never sent again

    await h.outbox.acknowledgeRejected(rejected[0].client_uuid);
    expect(h.outbox.getState().rejected).toBe(0);
    expect((await h.outbox.listRejected())[0].acknowledged_at).not.toBeNull();
  });

  it('replays safely after a lost response: the same client_uuid is sent again', async () => {
    const serverSeen = new Set<string>();
    let serverTxns = 0;
    let dropFirstResponse = true;
    h.respond((c) => {
      // The server treats a repeated client_uuid as already done.
      if (!serverSeen.has(c.client_uuid)) {
        serverSeen.add(c.client_uuid);
        serverTxns++;
      }
      if (dropFirstResponse) {
        dropFirstResponse = false;
        return transient; // processed, but the answer never arrived
      }
      return { ok: true, data: null };
    });
    const cmd = await h.outbox.enqueue('post_txn', { n: 1 });
    await h.outbox.drain();
    await h.outbox.drain();
    expect(h.calls.map((c) => c.client_uuid)).toEqual([cmd.client_uuid, cmd.client_uuid]);
    expect(serverTxns).toBe(1);
    expect(h.outbox.getState().queued).toBe(0);
  });

  it('never stores the same client_uuid twice', async () => {
    const twin = harness(h.dbName, 'a'); // same uuid sequence as h
    await h.outbox.enqueue('post_txn', { n: 1 });
    await expect(twin.outbox.enqueue('post_txn', { n: 1 })).rejects.toThrow();
    expect(await h.outbox.listQueued()).toHaveLength(1);
  });

  it('survives a reload: a new instance on the same database continues the queue in order', async () => {
    h.setOnline(false);
    await h.outbox.enqueue('post_txn', { n: 1 });
    await h.outbox.enqueue('post_txn', { n: 2 });

    const reloaded = harness(h.dbName, 'b');
    await reloaded.outbox.enqueue('post_txn', { n: 3 });
    await reloaded.outbox.drain();
    expect(reloaded.calls.map((c) => c.args.n)).toEqual([1, 2, 3]);
    expect(reloaded.outbox.getState().queued).toBe(0);
  });

  it('runs one drain at a time and picks up commands queued during a drain', async () => {
    let release: (() => void) | null = null;
    h.respond(
      () =>
        new Promise<RpcOutcome>((resolve) => {
          release = () => resolve({ ok: true, data: null });
        }),
    );
    await h.outbox.enqueue('post_txn', { n: 1 });
    const first = h.outbox.drain();
    const second = h.outbox.drain();
    expect(second).toBe(first);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.calls).toHaveLength(1);
    h.respond(() => ({ ok: true, data: null }));
    await h.outbox.enqueue('post_txn', { n: 2 });
    release!();
    await first;
    expect(h.calls.map((c) => c.args.n)).toEqual([1, 2]);
  });

  it('notifies subscribers with a stable snapshot', async () => {
    let notifications = 0;
    const off = h.outbox.subscribe(() => notifications++);
    const before = h.outbox.getState();
    expect(h.outbox.getState()).toBe(before);
    await h.outbox.enqueue('post_txn', { n: 1 });
    expect(notifications).toBeGreaterThan(0);
    expect(h.outbox.getState()).not.toBe(before);
    expect(h.outbox.getState().queued).toBe(1);
    off();
  });

  describe('submit', () => {
    it('resolves done with the server data when online', async () => {
      h.respond(() => ({ ok: true, data: { txn_id: 'T1' } }));
      const result = await h.outbox.submit('post_txn', { n: 1 });
      expect(result).toMatchObject({ status: 'done', data: { txn_id: 'T1' } });
    });

    it('resolves queued when offline or backing off', async () => {
      h.setOnline(false);
      expect(await h.outbox.submit('post_txn', { n: 1 })).toMatchObject({ status: 'queued' });
      h.setOnline(true);
      h.respond(() => transient);
      expect(await h.outbox.submit('post_txn', { n: 2 })).toMatchObject({ status: 'queued' });
      expect(h.outbox.getState().queued).toBe(2);
    });

    it('resolves rejected with the business code', async () => {
      h.respond(() => ({ ok: false, kind: 'business', code: 'LANE_MIXED', message: 'LANE_MIXED' }));
      expect(await h.outbox.submit('post_txn', { n: 1 })).toMatchObject({ status: 'rejected', code: 'LANE_MIXED' });
    });
  });
});
