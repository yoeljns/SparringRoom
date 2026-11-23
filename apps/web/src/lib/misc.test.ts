import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { hasMessage, t, tDynamic } from '@/i18n';
import tr from '@/i18n/tr.json';
import { FLOOR_SCREENS, OFFICE_SCREENS, ROLES } from '@dayson/domain';
import { isAuthorizedCron } from './cron';
import { businessCodeOf, classifyRpcError, POST_TXN_ERROR_CODES } from './data/rpc';
import { fetchProfile, toProfile } from './data/profile';
import { TONES, VIBRATION } from './floor/feedback';
import { printerFromEnv, sendZpl } from './labels/print';
import { isPublicPath, safeNextPath } from './supabase/session';

describe('i18n', () => {
  it('returns Turkish strings and fills variables', () => {
    expect(t('floor.screens.tasks')).toBe('Görevlerim');
    expect(t('flow.step', { n: 2, total: 3 })).toBe('Adım 2 / 3');
    expect(t('auth.noAccessBody', {})).toContain('{role}');
    expect(tDynamic('errors.LANE_MIXED', 'errors.UNKNOWN')).toBe(tr.errors.LANE_MIXED);
    expect(tDynamic('errors.SOMETHING_NEW', 'errors.UNKNOWN')).toBe(tr.errors.UNKNOWN);
    expect(hasMessage('nope.nope')).toBe(false);
  });

  it('uses the labels of the spec for the nine floor screens and the office sections', () => {
    expect(FLOOR_SCREENS.map((s) => tr.floor.screens[s])).toEqual([
      'Görevlerim', 'Mal Kabul', 'Kalite', 'Yerleştirme', 'Toplama', 'Yükleme', 'Sayım', 'Transfer', 'Sorgu',
    ]);
    expect(OFFICE_SCREENS.map((s) => tr.office.nav[s])).toEqual([
      'Pano', 'Stok', 'Siparişler', 'Sevkiyat', 'Satınalma / Üretim', 'Planlama', 'Kampanyalar', 'Bayiler', 'Mutabakat', 'Onaylar',
      'Uyarılar', 'Ana Veriler', 'Denetim',
    ]);
  });

  it('has a string for every role, screen description and post_txn error', () => {
    for (const role of ROLES) expect(tr.roles[role]).toBeTruthy();
    for (const s of FLOOR_SCREENS) expect(tr.floor.desc[s]).toBeTruthy();
    for (const s of OFFICE_SCREENS) expect(tr.office.desc[s]).toBeTruthy();
    for (const code of POST_TXN_ERROR_CODES) expect(hasMessage(`errors.${code}`)).toBe(true);
  });
});

describe('classifyRpcError', () => {
  it('treats network failures, timeouts, rate limits and 5xx as transient', () => {
    for (const status of [0, 408, 429, 500, 502, 503, 504]) {
      expect(classifyRpcError({ status, message: 'x' })).toMatchObject({ kind: 'transient' });
    }
    expect(classifyRpcError({ message: 'TypeError: Failed to fetch' })).toMatchObject({ kind: 'transient' });
    expect(classifyRpcError({ status: 400, code: '40001', message: 'could not serialize access' })).toMatchObject({ kind: 'transient' });
  });

  it('treats an expired session as transient and flags it', () => {
    expect(classifyRpcError({ status: 401, code: 'PGRST301', message: 'JWT expired' })).toEqual({
      ok: false, kind: 'transient', message: 'JWT expired', auth: true,
    });
  });

  it('treats raised exceptions and constraint errors as business refusals', () => {
    expect(classifyRpcError({ status: 400, code: 'P0001', message: 'NEGATIVE_BALANCE: lane TZ-B03-L12 would go below zero' })).toEqual({
      ok: false, kind: 'business', code: 'NEGATIVE_BALANCE', message: 'NEGATIVE_BALANCE: lane TZ-B03-L12 would go below zero',
    });
    expect(classifyRpcError({ status: 403, code: '42501', message: 'permission denied for function post_txn' })).toMatchObject({
      kind: 'business', code: '42501',
    });
    expect(classifyRpcError({ status: 404, code: 'PGRST202', message: 'Could not find the function' })).toMatchObject({ kind: 'business' });
    expect(classifyRpcError({ status: 500, code: 'P0001', message: 'LANE_MIXED' })).toMatchObject({ kind: 'business', code: 'LANE_MIXED' });
    expect(businessCodeOf({ message: 'something odd', code: null })).toBe('UNKNOWN');
  });
});

describe('profile rows', () => {
  it('accepts a valid app_user row and rejects an unknown role', () => {
    expect(toProfile({ id: 'u1', full_name: 'Ayşe Demir', role: 'ops_manager', active: true })).toEqual({
      id: 'u1', full_name: 'Ayşe Demir', role: 'ops_manager', active: true,
    });
    expect(toProfile({ id: 'u1', full_name: 'X', role: 'admin', active: true })).toBeNull();
    expect(toProfile(null)).toBeNull();
    expect(toProfile({ id: 'u1', role: 'operator', active: false })?.active).toBe(false);
  });
});

describe('fetchProfile', () => {
  const row = { id: 'u1', full_name: 'Mehmet Yılmaz', role: 'operator', active: true };
  // Just enough of the Supabase client for fetchProfile.
  function client(opts: { session?: unknown; sessionError?: unknown; user?: unknown; userError?: unknown; row?: unknown; rowError?: unknown }) {
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({ data: opts.row ?? null, error: opts.rowError ?? null }),
    };
    return {
      auth: {
        getSession: async () => ({ data: { session: opts.session ?? null }, error: opts.sessionError ?? null }),
        getUser: async () => ({ data: { user: opts.user ?? null }, error: opts.userError ?? null }),
      },
      from: () => builder,
    } as unknown as Parameters<typeof fetchProfile>[0];
  }

  it('returns the profile of the signed-in user', async () => {
    expect(await fetchProfile(client({ user: { id: 'u1' }, row }))).toEqual({ status: 'ready', profile: row });
    expect(await fetchProfile(client({ session: { user: { id: 'u1' } }, row }), { localSession: true })).toEqual({ status: 'ready', profile: row });
  });

  it('reports signed_out, missing and inactive', async () => {
    expect(await fetchProfile(client({}))).toEqual({ status: 'signed_out' });
    expect(await fetchProfile(client({}), { localSession: true })).toEqual({ status: 'signed_out' });
    expect(await fetchProfile(client({ userError: { name: 'AuthSessionMissingError', status: 400, message: 'no session' } }))).toEqual({ status: 'signed_out' });
    expect(await fetchProfile(client({ user: { id: 'u1' } }))).toEqual({ status: 'missing' });
    expect(await fetchProfile(client({ user: { id: 'u1' }, row: { ...row, active: false } }))).toMatchObject({ status: 'inactive' });
  });

  it('reports a network failure as error, never as signed_out', async () => {
    const offline = { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' };
    expect(await fetchProfile(client({ userError: offline }))).toEqual({ status: 'error', message: 'Failed to fetch' });
    expect(await fetchProfile(client({ sessionError: offline }), { localSession: true })).toEqual({ status: 'error', message: 'Failed to fetch' });
    expect(await fetchProfile(client({ session: { user: { id: 'u1' } }, rowError: { message: 'TypeError: Failed to fetch' } }), { localSession: true })).toEqual({
      status: 'error', message: 'TypeError: Failed to fetch',
    });
  });
});

describe('route protection helpers', () => {
  it('only allows same-site relative next paths', () => {
    expect(safeNextPath('/floor/pick?truck=1')).toBe('/floor/pick?truck=1');
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath('//evil.example')).toBe('/');
    expect(safeNextPath('/\\evil.example')).toBe('/');
    expect(safeNextPath('/login')).toBe('/');
    expect(safeNextPath(null)).toBe('/');
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/floor')).toBe(false);
  });
});

describe('cron authorisation', () => {
  it('needs the exact bearer secret', () => {
    expect(isAuthorizedCron('Bearer s3cret', 's3cret')).toBe(true);
    expect(isAuthorizedCron('Bearer wrong!', 's3cret')).toBe(false);
    expect(isAuthorizedCron('s3cret', 's3cret')).toBe(false);
    expect(isAuthorizedCron(null, 's3cret')).toBe(false);
    expect(isAuthorizedCron('Bearer ', '')).toBe(false);
    expect(isAuthorizedCron('Bearer undefined', undefined)).toBe(false);
  });
});

describe('feedback patterns', () => {
  it('uses clearly different tones and vibrations for accepted and refused', () => {
    expect(TONES.accepted.map((s) => s.frequency)).toEqual([880, 1320]);
    expect(TONES.refused.every((s) => s.frequency < 300 && s.type === 'square')).toBe(true);
    expect(TONES.accepted.every((s) => s.type === 'sine')).toBe(true);
    expect(VIBRATION.accepted).not.toEqual(VIBRATION.refused);
  });
});

describe('label printer', () => {
  it('reads the target from the environment', () => {
    expect(printerFromEnv({ PRINTER_HOST: '10.0.0.50' })).toEqual({ host: '10.0.0.50', port: 9100 });
    expect(printerFromEnv({ PRINTER_HOST: 'zd230', PRINTER_PORT: '6101' })).toEqual({ host: 'zd230', port: 6101 });
    expect(printerFromEnv({})).toBeNull();
    expect(printerFromEnv({ PRINTER_HOST: 'x', PRINTER_PORT: 'abc' })).toBeNull();
  });

  it('sends the ZPL as UTF-8 over TCP', async () => {
    const received = new Promise<string>((resolve) => {
      const server = net.createServer((socket) => {
        const chunks: Buffer[] = [];
        socket.on('data', (c) => chunks.push(c));
        socket.on('end', () => {
          server.close();
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
      });
      server.listen(0, '127.0.0.1', async () => {
        const port = (server.address() as net.AddressInfo).port;
        await sendZpl({ host: '127.0.0.1', port }, '^XA^CI28^FDŞeffaf ğ İ^FS^XZ');
      });
    });
    expect(await received).toBe('^XA^CI28^FDŞeffaf ğ İ^FS^XZ');
  });

  it('fails when the printer is unreachable', async () => {
    const server = net.createServer();
    const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
    await new Promise((resolve) => server.close(resolve));
    await expect(sendZpl({ host: '127.0.0.1', port }, '^XA^XZ', 1000)).rejects.toThrow();
  });
});
