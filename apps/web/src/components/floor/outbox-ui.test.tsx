import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import tr from '@/i18n/tr.json';
import type { RpcOutcome } from '@/lib/data/rpc';
import { Outbox } from '@/lib/floor/outbox/engine';
import { OutboxProvider, useOutbox } from '@/lib/floor/outbox/react';
import { createIdbOutboxStore } from '@/lib/floor/outbox/store';
import { BlockUntilDrained } from './BlockUntilDrained';
import { OutboxBadge } from './OutboxBadge';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

let n = 0;
function makeOutbox() {
  let online = false;
  let outcome: RpcOutcome = { ok: true, data: null };
  const outbox = new Outbox({
    store: createIdbOutboxStore(`outbox-ui-${++n}`),
    callRpc: async () => outcome,
    isOnline: () => online,
    schedule: () => () => {},
  });
  return {
    outbox,
    setOnline: (v: boolean) => (online = v),
    setOutcome: (o: RpcOutcome) => (outcome = o),
  };
}

function Count() {
  const { queued } = useOutbox();
  return <span data-testid="hook-count">{queued}</span>;
}

describe('outbox UI', () => {
  it('shows the queued count, blocks completion until the queue drains, then unblocks', async () => {
    const h = makeOutbox();
    render(
      <OutboxProvider outbox={h.outbox}>
        <OutboxBadge />
        <Count />
        <BlockUntilDrained>
          <button type="button">Tırı kapat</button>
        </BlockUntilDrained>
      </OutboxProvider>,
    );
    await screen.findByText('Tırı kapat'); // empty queue: not blocked
    expect(screen.getByTestId('outbox-count').textContent).toBe('0');

    await act(async () => {
      await h.outbox.enqueue('post_txn', { n: 1 });
      await h.outbox.enqueue('post_txn', { n: 2 });
    });
    expect(screen.getByTestId('outbox-count').textContent).toBe('2');
    expect(screen.getByTestId('hook-count').textContent).toBe('2');
    expect(screen.queryByText('Tırı kapat')).toBeNull();
    expect(screen.getByTestId('blocked-queued').textContent).toContain(tr.outbox.blockedTitle);

    h.setOnline(true);
    await act(async () => {
      await h.outbox.drain();
    });
    await waitFor(() => expect(screen.getByTestId('outbox-count').textContent).toBe('0'));
    expect(screen.getByText('Tırı kapat')).toBeTruthy();
  });

  it('blocks on a rejected command until the operator acknowledges it', async () => {
    const h = makeOutbox();
    h.setOnline(true);
    h.setOutcome({ ok: false, kind: 'business', code: 'NEGATIVE_BALANCE', message: 'NEGATIVE_BALANCE' });
    render(
      <OutboxProvider outbox={h.outbox}>
        <OutboxBadge />
        <BlockUntilDrained>
          <button type="button">Sayımı bitir</button>
        </BlockUntilDrained>
      </OutboxProvider>,
    );
    await screen.findByText('Sayımı bitir');
    await act(async () => {
      await h.outbox.enqueue('post_txn', { n: 1 });
      await h.outbox.drain();
    });
    expect(screen.getByTestId('blocked-rejected').textContent).toContain(tr.outbox.blockedRejectedTitle);
    expect(screen.getByTestId('outbox-badge').className).toContain('bg-brand');

    const [rejected] = await h.outbox.listRejected();
    await act(async () => {
      await h.outbox.acknowledgeRejected(rejected.client_uuid);
    });
    expect(screen.getByText('Sayımı bitir')).toBeTruthy();
  });
});
