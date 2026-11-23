// LOCAL DEVELOPMENT ONLY. Emulates the subset of Supabase the web app uses:
//   /auth/v1/*     password sign-in for the dev users (one shared dev password), refresh, user, logout
//   /rest/v1/rpc/* function calls (the app's write path and most reads)
//   /rest/v1/<t>   simple selects: select=cols, eq/neq/gt/gte/lt/lte/like/ilike/is/in filters, order, limit, offset
//   /storage/v1/*  object upload / download to a local folder
// Every request runs as the database role `authenticated` (or `anon`) with request.jwt.claims
// set, exactly like PostgREST, so row-level security and app.user_role() behave as in production.
// It is NOT PostgREST: embedded resources, or=(), and upserts are not supported and return 400.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const PORT = Number(process.env.DEV_API_PORT || 54321);
const DB = process.env.DATABASE_URL || 'postgresql://postgres@127.0.0.1:54329/dayson_web';
const SECRET = process.env.DEV_JWT_SECRET || 'dev-only-secret-not-for-production-use-0000';
const PASSWORD = process.env.DEV_PASSWORD || 'dayson123';
const STORE = process.env.DEV_STORAGE_DIR || '/tmp/dayson-dev-storage';
const pool = new pg.Pool({ connectionString: DB, max: 10 });
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric -> number, like PostgREST JSON
const IDENT = /^[a-z_][a-z0-9_]*$/;

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function sign(payload) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const sig = crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function verify(token) {
  try {
    const [h, b, s] = token.split('.');
    const sig = crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url');
    if (sig !== s) return null;
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    if (p.exp && p.exp < Date.now() / 1000) return null;
    return p;
  } catch { return null; }
}
function session(user) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600 * 12;
  const u = { id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, app_metadata: {}, user_metadata: {}, created_at: user.created_at };
  return {
    access_token: sign({ sub: user.id, role: 'authenticated', aud: 'authenticated', email: user.email, exp, iat: now }),
    token_type: 'bearer', expires_in: exp - now, expires_at: exp, refresh_token: b64(user.id), user: u,
  };
}
function claimsOf(req) {
  const auth = req.headers.authorization || '';
  const tok = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const p = tok ? verify(tok) : null;
  return p && p.role === 'authenticated' ? p : { role: 'anon' };
}
async function asCaller(claims, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${claims.role === 'authenticated' ? 'authenticated' : 'anon'}`);
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally { c.release(); }
}
function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD',
    'access-control-expose-headers': 'content-range',
    ...headers,
  });
  res.end(data);
}
function pgError(res, e) {
  const status = e.code === '42501' ? 403 : e.code === '42883' || e.code === '42P01' ? 404 : 400;
  send(res, status, { code: e.code || 'XX000', message: e.message, details: e.detail || null, hint: e.hint || null });
}
async function readBody(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  return Buffer.concat(chunks);
}

let procs = null;
async function loadProcs() {
  const r = await pool.query(`select p.proname, p.proargnames, p.proretset, p.prorettype::regtype::text as ret,
       array(select t::regtype::text from unnest(p.proargtypes) t) as argtypes
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`);
  procs = new Map();
  for (const row of r.rows) procs.set(row.proname, row);
}

async function rpc(req, res, name, claims) {
  if (!procs || !procs.has(name)) await loadProcs();
  const fn = procs.get(name);
  if (!fn || !IDENT.test(name)) return send(res, 404, { code: 'PGRST202', message: `function ${name} not found` });
  const raw = await readBody(req);
  const args = raw.length ? JSON.parse(raw.toString()) : {};
  const names = Object.keys(args);
  const params = [];
  const parts = names.map((k, i) => {
    if (!IDENT.test(k)) throw Object.assign(new Error(`bad argument ${k}`), { code: '22023' });
    const idx = (fn.proargnames || []).indexOf(k);
    const type = idx >= 0 ? fn.argtypes[idx] : 'text';
    const v = args[k];
    params.push(v === null || v === undefined ? null : type === 'jsonb' || type === 'json' ? JSON.stringify(v) : v);
    return `${k} => $${i + 1}::${type}`;
  });
  const call = `public.${name}(${parts.join(', ')})`;
  const sql = fn.ret === 'void' ? `select ${call}`
    : fn.proretset ? `select coalesce(json_agg(x), '[]'::json) as r from ${call} x`
    : `select to_json(${call}) as r`;
  try {
    const out = await asCaller(claims, (c) => c.query(sql, params));
    send(res, 200, fn.ret === 'void' ? '' : JSON.stringify(out.rows[0].r ?? null));
  } catch (e) { pgError(res, e); }
}

const OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'like', ilike: 'ilike' };
function filterSql(col, expr, params) {
  let neg = false;
  if (expr.startsWith('not.')) { neg = true; expr = expr.slice(4); }
  const dot = expr.indexOf('.');
  const op = expr.slice(0, dot);
  const val = expr.slice(dot + 1);
  let sql;
  if (op === 'is') {
    if (!['null', 'true', 'false'].includes(val)) throw new Error('bad is filter');
    sql = `${col} is ${val}`;
  } else if (op === 'in') {
    const items = val.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, ''));
    params.push(items);
    sql = `${col}::text = any($${params.length})`;
  } else if (OPS[op]) {
    params.push(op.includes('like') ? val.replaceAll('*', '%') : val);
    sql = `${col}::text ${OPS[op]} $${params.length}`;
    if (['gt', 'gte', 'lt', 'lte'].includes(op)) sql = `${col} ${OPS[op]} $${params.length}::text::${'unknown' && 'text'}`;
  } else throw new Error(`dev-api: filter operator "${op}" is not supported`);
  return neg ? `not (${sql})` : sql;
}

async function table(req, res, name, url, claims) {
  if (!IDENT.test(name)) return send(res, 404, { message: 'not found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 400, { code: 'DEV', message: 'dev-api: tables are read-only; every write goes through rpc functions' });
  }
  const q = url.searchParams;
  const params = [];
  try {
    let cols = '*';
    const sel = q.get('select');
    if (sel && sel !== '*') {
      const list = sel.split(',').map((s) => s.trim());
      for (const c of list) if (!IDENT.test(c)) throw new Error(`dev-api: select "${c}" is not supported (plain columns only; use a view or an rpc for joins)`);
      cols = list.join(', ');
    }
    // column types, so range filters compare with the right type
    const meta = await pool.query(`select column_name, udt_name from information_schema.columns where table_schema = 'public' and table_name = $1`, [name]);
    const types = Object.fromEntries(meta.rows.map((r) => [r.column_name, r.udt_name]));
    const where = [];
    for (const [k, v] of q.entries()) {
      if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
      if (k === 'or' || k === 'and') throw new Error('dev-api: or=/and= filters are not supported; use a view or an rpc');
      if (!IDENT.test(k) || !types[k]) throw new Error(`dev-api: unknown column ${k}`);
      let neg = false, expr = v;
      if (expr.startsWith('not.')) { neg = true; expr = expr.slice(4); }
      const dot = expr.indexOf('.');
      const op = expr.slice(0, dot), val = expr.slice(dot + 1);
      let sql;
      if (op === 'is') { if (!['null', 'true', 'false'].includes(val)) throw new Error('bad is filter'); sql = `${k} is ${val}`; }
      else if (op === 'in') { params.push(val.replace(/^\(|\)$/g, '').split(',').filter((s) => s.length).map((s) => s.replace(/^"|"$/g, ''))); sql = `${k}::text = any($${params.length}::text[])`; }
      else if (op === 'like' || op === 'ilike') { params.push(val.replaceAll('*', '%')); sql = `${k}::text ${op} $${params.length}`; }
      else if (OPS[op]) { params.push(val); sql = `${k} ${OPS[op]} $${params.length}::${types[k]}`; }
      else throw new Error(`dev-api: filter operator "${op}" is not supported`);
      where.push(neg ? `not (${sql})` : sql);
    }
    let sql = `select ${cols} from public.${name}`;
    if (where.length) sql += ` where ${where.join(' and ')}`;
    const order = q.get('order');
    if (order) {
      sql += ' order by ' + order.split(',').map((o) => {
        const [c, ...mods] = o.split('.');
        if (!IDENT.test(c)) throw new Error('bad order');
        return `${c}${mods.includes('desc') ? ' desc' : ''}${mods.includes('nullsfirst') ? ' nulls first' : mods.includes('nullslast') ? ' nulls last' : ''}`;
      }).join(', ');
    }
    let limit = q.get('limit') ? Number(q.get('limit')) : null;
    let offset = q.get('offset') ? Number(q.get('offset')) : 0;
    const range = req.headers.range;
    if (range && /^\d+-\d+$/.test(range)) { const [a, b] = range.split('-').map(Number); offset = a; limit = b - a + 1; }
    if (limit !== null) sql += ` limit ${Math.max(0, Math.floor(limit))}`;
    if (offset) sql += ` offset ${Math.max(0, Math.floor(offset))}`;
    const single = (req.headers.accept || '').includes('vnd.pgrst.object');
    const wantCount = (req.headers.prefer || '').includes('count=exact');
    const out = await asCaller(claims, async (c) => {
      const rows = (await c.query(sql, params)).rows;
      let count = null;
      if (wantCount) count = Number((await c.query(`select count(*) from public.${name}${where.length ? ` where ${where.join(' and ')}` : ''}`, params)).rows[0].count);
      return { rows, count };
    });
    const headers = { 'content-range': `${offset}-${offset + Math.max(out.rows.length - 1, 0)}/${out.count ?? '*'}` };
    if (single) {
      if (out.rows.length !== 1) {
        if (out.rows.length === 0 && (req.headers.accept || '').includes('nulls=stripped')) return send(res, 200, 'null', headers);
        return send(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${out.rows.length} rows` });
      }
      return send(res, 200, out.rows[0], headers);
    }
    send(res, 200, req.method === 'HEAD' ? '' : out.rows, headers);
  } catch (e) { pgError(res, e); }
}

async function auth(req, res, url) {
  const p = url.pathname.replace('/auth/v1', '');
  if (p === '/token' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const grant = url.searchParams.get('grant_type');
    let user = null;
    if (grant === 'password') {
      if (body.password === PASSWORD) user = (await pool.query('select id, email, created_at from auth.users where lower(email) = lower($1)', [body.email || ''])).rows[0];
    } else if (grant === 'refresh_token') {
      const id = Buffer.from(body.refresh_token || '', 'base64url').toString();
      if (/^[0-9a-f-]{36}$/.test(id)) user = (await pool.query('select id, email, created_at from auth.users where id = $1', [id])).rows[0];
    }
    if (!user) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
    return send(res, 200, session(user));
  }
  if (p === '/user' && req.method === 'GET') {
    const c = claimsOf(req);
    if (c.role !== 'authenticated') return send(res, 401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' });
    const user = (await pool.query('select id, email, created_at from auth.users where id = $1', [c.sub])).rows[0];
    if (!user) return send(res, 401, { code: 401, msg: 'user not found' });
    return send(res, 200, session(user).user);
  }
  if (p === '/logout') return send(res, 204);
  send(res, 404, { message: 'dev-api: auth endpoint not emulated' });
}

async function storage(req, res, url, claims) {
  if (claims.role !== 'authenticated') return send(res, 401, { message: 'unauthorized' });
  const m = url.pathname.match(/^\/storage\/v1\/object\/(?:list\/)?([a-z0-9-]+)\/?(.*)$/);
  if (!m) return send(res, 404, { message: 'not found' });
  const role = await asCaller(claims, async (c) => (await c.query('select app.user_role() as r')).rows[0].r);
  if (!['finance', 'ops_manager', 'owner'].includes(role)) return send(res, 403, { message: 'new row violates row-level security policy' });
  const file = path.join(STORE, m[1], path.normalize('/' + decodeURIComponent(m[2])).replace(/^\/+/, ''));
  if (url.pathname.includes('/object/list/')) {
    const dir = path.join(STORE, m[1]);
    const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    return send(res, 200, names.map((n) => ({ name: n, created_at: fs.statSync(path.join(dir, n)).mtime.toISOString() })));
  }
  if (req.method === 'POST' || req.method === 'PUT') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let body = await readBody(req);
    const ct = req.headers['content-type'] || '';
    if (ct.startsWith('multipart/form-data')) {
      const boundary = '--' + ct.split('boundary=')[1];
      const text = body.toString('latin1');
      const start = text.indexOf('\r\n\r\n', text.indexOf(boundary)) + 4;
      const end = text.lastIndexOf('\r\n' + boundary);
      body = Buffer.from(text.slice(start, end), 'latin1');
    }
    fs.writeFileSync(file, body);
    return send(res, 200, { Key: `${m[1]}/${m[2]}`, path: m[2] });
  }
  if (req.method === 'GET') {
    if (!fs.existsSync(file)) return send(res, 404, { message: 'Object not found' });
    return send(res, 200, fs.readFileSync(file), { 'content-type': 'text/csv; charset=utf-8' });
  }
  send(res, 400, { message: 'dev-api: storage operation not emulated' });
}

http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const claims = claimsOf(req);
    if (url.pathname.startsWith('/auth/v1')) return await auth(req, res, url);
    if (url.pathname.startsWith('/storage/v1')) return await storage(req, res, url, claims);
    if (url.pathname.startsWith('/rest/v1/rpc/')) return await rpc(req, res, url.pathname.slice('/rest/v1/rpc/'.length), claims);
    if (url.pathname.startsWith('/rest/v1/')) return await table(req, res, url.pathname.slice('/rest/v1/'.length), url, claims);
    send(res, 404, { message: 'not found' });
  } catch (e) {
    send(res, 500, { message: String(e && e.message || e) });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`dayson dev-api on http://127.0.0.1:${PORT} -> ${DB}`));
