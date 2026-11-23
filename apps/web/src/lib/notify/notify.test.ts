import { describe, expect, it, vi } from 'vitest';
import { runAlerts, runDigest } from './cron';
import { digestSections, payloadLine, renderAlerts, renderDigest } from './render';
import { deliver, notifyEnv, resolveTargets, sendEmail, sendTelegram, splitTelegram, type NotifyEnv } from './send';

const DIGEST = {
  date: '2026-11-23',
  accuracy: { ira_yesterday: 98.5, ira_7d: 99.1, scan_yesterday: null, scan_7d: 97 },
  reconciliation: { by_class: { timing: 2, true_variance: 1 }, older_than_48h: 1 },
  below_safety_4w: [{ sku: 'DYS-PU-GRI-SOS', week: '2026-12-07', projected: 1200, safety_stock: 2400 }],
  lots_amber_red: [{ sku: 'DYS-PU-BEYAZ-KRT', lot_no: 'L1', days_left: 200, expiry_date: '2027-06-11', band: 'amber' }],
  expiry_blocked_waiting: [{ sku: 'DYS-PU-SIYAH-KRT', lot_no: 'L9', qty: 600 }],
  inbound_late: [], campaigns_off_forecast: [], weight_overrides: [{ shipment_no: 'SH-1', loaded_kg: 25200 }], shipments_no_invoice: [],
  approvals_waiting: [{ id: 'a1', type: 'param_publish', reason: 'Servis seviyesi <artış>', created_at: '2026-11-23T08:00:00Z', for_owner: true }, { id: 'a2', type: 'scrap', reason: null, for_owner: false }],
  negative_fva_sources: [{ source: 'planner', fva: -0.04 }],
};

interface Init { method: string; headers: Record<string, string>; body: string }
interface Res { ok: boolean; status: number; text: () => Promise<string> }
const okRes: Res = { ok: true, status: 200, text: () => Promise.resolve('{}') };
const mockFetch = (impl: () => Promise<Res> = () => Promise.resolve(okRes)) => vi.fn<(url: string, init: Init) => Promise<Res>>(impl);
const full: NotifyEnv = { RESEND_API_KEY: 'rk', DIGEST_EMAIL_FROM: 'depo@dayson.test', DIGEST_EMAIL_TO: 'sahip@dayson.test, mudur@dayson.test', TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '-100' };

describe('digest rendering', () => {
  it('has the eight sections of spec 12.4 in order, each with a link', () => {
    const sections = digestSections(DIGEST);
    expect(sections.map((s) => s.key)).toEqual(['accuracy', 'reconciliation', 'below_safety', 'lots', 'inbound_late', 'campaigns', 'trucks', 'approvals']);
    expect(sections.every((s) => s.path.startsWith('/') && s.lines.length > 0)).toBe(true);
    expect(sections.filter((s) => s.flagged).map((s) => s.key)).toEqual(['reconciliation', 'below_safety', 'lots', 'trucks', 'approvals']);
  });

  it('writes Turkish text with links to APP_URL and escapes user text', () => {
    const r = renderDigest(DIGEST, 'https://depo.dayson.test/');
    expect(r.subject).toBe('Dayson günlük özet, 23.11.2026');
    expect(r.text).toContain('<a href="https://depo.dayson.test/reconciliation?tab=diffs">Açık mutabakat farkları</a>');
    expect(r.text).toContain('Kayıt doğruluğu: dün %98,5, 7 gün %99,1');
    expect(r.text).toContain('Okutma uyumu: dün —, 7 gün %97');
    expect(r.text).toContain('48 saati aşan açıklanmamış fark: 1');
    expect(r.text).toContain('DYS-PU-GRI-SOS: 07.12.2026 haftasında 1.200 (emniyet 2.400)');
    expect(r.text).toContain('Firma Sahibini bekleyen: 1 (toplam bekleyen: 2)');
    expect(r.text).toContain('Servis seviyesi &lt;artış&gt;');
    expect(r.html).toContain('href="https://depo.dayson.test/approvals"');
    expect(r.html).not.toContain('<artış>');
  });

  it('renders an empty digest without failing', () => {
    const r = renderDigest({ date: '2026-01-02' }, 'http://x');
    expect(r.sections).toHaveLength(8);
    expect(r.text).toContain('Yok.');
    expect(r.sections.some((s) => s.flagged)).toBe(false);
  });

  it('describes payloads with translated labels and dates', () => {
    expect(payloadLine({ sku: 'A', expiry_date: '2027-07-16', nested: { x: 1 }, days_left: 234 })).toBe('Stok kodu: A, SKT: 16.07.2027, Kalan gün: 234');
  });
});

describe('alert rendering', () => {
  it('links every alert and names the rule in Turkish', () => {
    const r = renderAlerts([{ id: 'x1', rule: 'import_file_rejected', severity: 'critical', payload: { file_name: 'items_1.csv' } }, { id: 'x2', rule: 'new_rule', severity: 'warning', payload: {} }], 'https://app');
    expect(r.subject).toBe('Dayson: 2 anlık uyarı');
    expect(r.text).toContain('<a href="https://app/alerts?id=x1">Logo dosyası reddedildi</a>');
    expect(r.text).toContain('Dosya adı: items_1.csv');
    expect(r.text).toContain('new_rule');
  });
});

describe('delivery', () => {
  it('prefers the recipients own addresses and falls back to the env lists', () => {
    expect(resolveTargets([{ email: 'a@x', telegram_chat_id: null }, { email: 'a@x' }], full)).toEqual({ emails: ['a@x'], chats: ['-100'] });
    expect(resolveTargets([], full).emails).toEqual(['sahip@dayson.test', 'mudur@dayson.test']);
  });

  it('skips a channel cleanly when its configuration is missing', async () => {
    const fetchMock = mockFetch();
    const msg = renderDigest(DIGEST, 'http://x');
    const none = await deliver(msg, [], {}, fetchMock);
    expect(none).toEqual({ email: { sent: 0, skipped: 'RESEND_API_KEY missing', errors: [] }, telegram: { sent: 0, skipped: 'TELEGRAM_BOT_TOKEN missing', errors: [] }, delivered: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await sendEmail({ RESEND_API_KEY: 'k' }, ['a@x'], msg, fetchMock)).skipped).toBe('DIGEST_EMAIL_FROM missing');
    expect((await sendEmail({ RESEND_API_KEY: 'k', DIGEST_EMAIL_FROM: 'f@x' }, [], msg, fetchMock)).skipped).toBe('no email recipient');
    expect((await sendTelegram({ TELEGRAM_BOT_TOKEN: 't' }, [], msg, fetchMock)).skipped).toBe('no telegram chat');
  });

  it('calls Resend and the Telegram Bot API with the right payloads', async () => {
    const fetchMock = mockFetch();
    const msg = renderDigest(DIGEST, 'http://x');
    const report = await deliver(msg, [{ email: 'owner@dayson.test', telegram_chat_id: '42' }], full, fetchMock);
    expect(report.delivered).toBe(true);
    expect(report.email.sent).toBe(1);
    expect(report.telegram.sent).toBe(1);
    const [emailUrl, emailInit] = fetchMock.mock.calls.find((c) => String(c[0]).includes('resend'))!;
    expect(emailUrl).toBe('https://api.resend.com/emails');
    expect(emailInit.headers.Authorization).toBe('Bearer rk');
    expect(JSON.parse(emailInit.body)).toMatchObject({ from: 'depo@dayson.test', to: ['owner@dayson.test'], subject: msg.subject });
    const [tgUrl, tgInit] = fetchMock.mock.calls.find((c) => String(c[0]).includes('telegram'))!;
    expect(tgUrl).toBe('https://api.telegram.org/bottok/sendMessage');
    expect(JSON.parse(tgInit.body)).toMatchObject({ chat_id: '42', parse_mode: 'HTML' });
  });

  it('reports HTTP and network failures without throwing', async () => {
    const msg = renderDigest(DIGEST, 'http://x');
    const bad = mockFetch(() => Promise.resolve({ ok: false, status: 403, text: () => Promise.resolve('forbidden') }));
    const r1 = await deliver(msg, [], full, bad);
    expect(r1.delivered).toBe(false);
    expect(r1.email.errors[0]).toContain('resend 403');
    expect(r1.telegram.errors[0]).toContain('telegram 403');
    const down = mockFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    expect((await deliver(msg, [], full, down)).email.errors[0]).toContain('ECONNREFUSED');
  });

  it('splits long Telegram messages on blank lines', () => {
    const parts = splitTelegram(Array.from({ length: 30 }, (_, i) => `blok ${i} ${'x'.repeat(300)}`).join('\n\n'), 1000);
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
  });

  it('reads only its own variables from the environment', () => {
    expect(notifyEnv({ RESEND_API_KEY: '', TELEGRAM_CHAT_ID: '5', OTHER: 'x' })).toEqual({ RESEND_API_KEY: undefined, DIGEST_EMAIL_FROM: undefined, DIGEST_EMAIL_TO: undefined, TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: '5' });
  });
});

type Rpc = (name: string, args?: unknown) => Promise<{ data: unknown; error: { message: string } | null }>;
function fakeDb(rpc: Rpc, alerts: unknown[] = []) {
  const query = { select: () => query, eq: () => query, is: () => query, order: () => query, limit: () => Promise.resolve({ data: alerts, error: null }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { rpc: vi.fn(rpc), from: vi.fn(() => query) } as any;
}

describe('cron jobs', () => {
  it('digest: renders rpc_digest and reports what was sent', async () => {
    const db = fakeDb(async (name) => (name === 'rpc_digest' ? { data: DIGEST, error: null } : { data: [{ email: 'o@x', telegram_chat_id: null }], error: null }));
    const fetchMock = mockFetch();
    const res = await runDigest(db, { ...full, TELEGRAM_BOT_TOKEN: undefined }, 'https://app', fetchMock);
    expect(res).toMatchObject({ ok: true, job: 'digest', date: '2026-11-23', delivery: { email: { sent: 1 }, telegram: { sent: 0, skipped: 'TELEGRAM_BOT_TOKEN missing' } } });
    expect(res.flagged).toContain('approvals');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('digest: a database refusal is reported, nothing is sent', async () => {
    const fetchMock = mockFetch();
    const res = await runDigest(fakeDb(async () => ({ data: null, error: { message: 'NOT_PERMITTED: role' } })), full, 'https://app', fetchMock);
    expect(res).toEqual({ ok: false, job: 'digest', error: 'NOT_PERMITTED: role' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const ALERTS = [{ id: 'a1', rule: 'scrap_request', severity: 'warning', payload: { reason: 'hasarlı' } }, { id: 'a2', rule: 'nightly_job_failed', severity: 'critical', payload: { job: 'forecast' } }];

  it('alerts: pushes unsent alerts and marks them sent', async () => {
    const db = fakeDb(async (name) => (name === 'rpc_alerts_mark_sent' ? { data: 2, error: null } : { data: [{ email: null, telegram_chat_id: '7' }], error: null }), ALERTS);
    const fetchMock = mockFetch();
    const res = await runAlerts(db, full, 'https://app', fetchMock);
    expect(res).toMatchObject({ ok: true, pending: 2, marked_sent: 2 });
    expect(db.rpc).toHaveBeenCalledWith('rpc_alerts_mark_sent', { p_ids: ['a1', 'a2'] });
    expect(JSON.parse(fetchMock.mock.calls.find((c) => String(c[0]).includes('telegram'))![1].body).chat_id).toBe('7');
  });

  it('alerts: nothing is marked when no channel is configured or delivery fails', async () => {
    const rpc: Rpc = async () => ({ data: [], error: null });
    const db1 = fakeDb(rpc, ALERTS);
    const res1 = await runAlerts(db1, {}, 'https://app', mockFetch());
    expect(res1).toMatchObject({ ok: true, pending: 2, marked_sent: 0 });
    expect(db1.rpc).not.toHaveBeenCalledWith('rpc_alerts_mark_sent', expect.anything());
    const db2 = fakeDb(rpc, ALERTS);
    const res2 = await runAlerts(db2, full, 'https://app', mockFetch(() => Promise.reject(new Error('down'))));
    expect(res2).toMatchObject({ ok: false, marked_sent: 0 });
    expect(db2.rpc).not.toHaveBeenCalledWith('rpc_alerts_mark_sent', expect.anything());
  });

  it('alerts: no pending alerts means no calls', async () => {
    const fetchMock = mockFetch();
    expect(await runAlerts(fakeDb(async () => ({ data: [], error: null }), []), full, 'https://app', fetchMock)).toEqual({ ok: true, job: 'alerts', pending: 0, marked_sent: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
