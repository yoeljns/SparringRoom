/**
 * End-to-end run of the warehouse floor app against the real API.
 *
 * What it needs (all local):
 *   - the dev API gateway on http://127.0.0.1:54321 (scripts/dev-api/start.sh) with the seeded database
 *   - the web app, e.g. `pnpm --filter web exec next dev -p 3101`, with apps/web/.env.local pointing at the gateway
 *   - Playwright with its Chromium already installed (resolved through NODE_PATH; nothing is downloaded)
 *   - psql, to create a purchase order and to check database effects
 *
 * Run:   node apps/web/e2e/floor.e2e.mjs
 * Env:   BASE_URL (default http://localhost:3101; use localhost, next dev blocks its scripts for other hosts), API_URL (default http://127.0.0.1:54321),
 *        DATABASE_URL (default postgresql://postgres@127.0.0.1:54329/dayson_web),
 *        SHOTS (screenshot folder, default ./floor-shots), HEADED=1 to watch.
 *
 * Scans are simulated the way the Zebra scanner works: the code is typed into the focused scan field and
 * ended with Enter. Every step asserts what the screen shows and what the database holds afterwards.
 * The script creates its own documents (purchase order, sales order, count tasks) and never resets the database.
 * Exit code 0 when every step passed.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:3101';
const API = process.env.API_URL || 'http://127.0.0.1:54321';
const PG = process.env.DATABASE_URL || 'postgresql://postgres@127.0.0.1:54329/dayson_web';
const SHOTS = path.resolve(process.env.SHOTS || 'floor-shots');
const PASSWORD = 'dayson123';
const SKU = process.env.E2E_SKU || 'DYS-PU-KIRMIZI-SOS';
const GS = '\x1d';

fs.mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const sql = (q) => execFileSync('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', PG, '-c', q], { encoding: 'utf8' }).trim();
const sql1 = (q) => sql(q).split('\n')[0];

const tokens = new Map();
async function token(email) {
  if (tokens.has(email)) return tokens.get(email);
  const res = await fetch(`${API}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: 'dev-anon-key' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = await res.json();
  if (!body.access_token) throw new Error(`login ${email}: ${JSON.stringify(body)}`);
  tokens.set(email, body.access_token);
  return body.access_token;
}

async function rpc(email, name, args) {
  const res = await fetch(`${API}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: 'dev-anon-key', authorization: `Bearer ${await token(email)}` },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const floorCmd = (email, cmd, args) => rpc(email, 'rpc_floor', { p_cmd: cmd, p_args: { client_uuid: crypto.randomUUID(), ...args } });

function assert(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}
function eq(actual, expected, what) {
  if (String(actual) !== String(expected)) throw new Error(`${what}: expected "${expected}", got "${actual}"`);
}

/** GS1 mod-10 check digit. */
function checkDigit(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) sum += (digits.charCodeAt(digits.length - 1 - i) - 48) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}
function newSerial() {
  const body = '1' + '8690000' + String(Date.now()).slice(-9);
  return body + checkDigit(body);
}
const yymmdd = (iso) => iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);
const addDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

const results = [];
let failed = false;
async function step(name, fn) {
  const started = Date.now();
  try {
    const evidence = await fn();
    results.push({ name, ok: true, evidence: evidence ?? '' });
    console.log(`PASS  ${name}${evidence ? `  — ${evidence}` : ''}  (${Date.now() - started} ms)`);
    return true;
  } catch (err) {
    failed = true;
    const message = err instanceof Error ? err.message.split('\n').slice(0, 6).join(' | ') : String(err);
    results.push({ name, ok: false, evidence: message });
    console.log(`FAIL  ${name}  — ${message}`);
    // What the operator saw when it failed.
    const shotName = `FAILED-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 50)}.png`;
    await lastPage?.screenshot({ path: path.join(SHOTS, shotName), fullPage: true }).catch(() => {});
    return false;
  }
}

let browser;
let lastPage = null;
const contexts = [];
async function session(email, landing = '/floor') {
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale: 'tr-TR' });
  contexts.push(context);
  const page = await context.newPage();
  lastPage = page;
  page.on('pageerror', (err) => console.log(`   [pageerror ${email}] ${err.message}`));
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30000 });
  await page.goto(`${BASE}${landing}`);
  return { context, page };
}

async function open(page, route) {
  await page.goto(`${BASE}${route}`);
  await page.waitForLoadState('domcontentloaded');
}

/** Type a barcode into the scan field and press Enter, as the scanner does. */
async function scan(page, code) {
  lastPage = page;
  const input = page.getByTestId('scan-input');
  await input.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="scan-input"]');
    return !!el && !el.closest('div')?.className.includes('opacity-60');
  });
  await input.fill(code);
  await input.press('Enter');
}

/**
 * Screenshot of what the handheld shows. `full: true` also saves <name>-full.png with the scroll area
 * unrolled, for screens that are longer than the display.
 */
async function shot(page, name, { full = false } = {}) {
  // Let banners settle; hide the Next.js development badge, which is not part of the app.
  await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' }).catch(() => {});
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  if (!full) return;
  const restore = await page.evaluateHandle(() => {
    const root = document.querySelector('.floor-root');
    const main = document.querySelector('main');
    const prev = [root?.getAttribute('style') ?? null, main?.getAttribute('style') ?? null];
    root?.setAttribute('style', 'height:auto;min-height:100dvh');
    main?.setAttribute('style', 'overflow:visible;flex:none');
    return prev;
  });
  await page.screenshot({ path: path.join(SHOTS, `${name}-full.png`), fullPage: true });
  await page.evaluate((prev) => {
    const set = (el, v) => (v === null ? el?.removeAttribute('style') : el?.setAttribute('style', v));
    set(document.querySelector('.floor-root'), prev[0]);
    set(document.querySelector('main'), prev[1]);
  }, restore);
}

const text = async (page, testid) => ((await page.getByTestId(testid).first().textContent()) ?? '').trim();

async function waitOutboxEmpty(page, timeout = 20000) {
  await page.waitForFunction(() => document.querySelector('[data-testid="outbox-count"]')?.textContent?.trim() === '0', null, { timeout });
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

const run = { sku: SKU };

async function main() {
  browser = await chromium.launch({ headless: !process.env.HEADED });
  const today = sql1('select app.today()');
  const item = sql1(`select id || '|' || gtin from item where sku = '${SKU}'`).split('|');
  run.itemId = item[0];
  run.gtin = item[1];
  run.unitsPerPallet = Number(sql1(`select app.units_per_pallet('${run.itemId}', null)`));
  // FEFO: the lot must be the oldest eligible one so that allocation picks it; 200 days passes the 180-day shelf-life rule.
  run.expiry = addDays(today, 200);
  run.prod = addDays(today, -165);
  run.lot = `E${String(Date.now()).slice(-8)}`;
  run.serial = newSerial();

  await step('setup: purchase order created (psql)', async () => {
    const supplier = sql1(`select id from party where type = 'supplier' order by name limit 1`);
    run.poId = sql1(`insert into purchase_order (supplier_id, state, ordered_at, promised_date) values ('${supplier}', 'ordered', now(), current_date) returning id`);
    run.poLineId = sql1(`insert into po_line (po_id, line_no, item_id, qty) values ('${run.poId}', 1, '${run.itemId}', ${run.unitsPerPallet}) returning id`);
    run.poNo = sql1(`select po_no from purchase_order where id = '${run.poId}'`);
    return `${run.poNo}, 1 pallet (${run.unitsPerPallet}) of ${SKU}`;
  });

  // ---- operator signs in -------------------------------------------------
  let op;
  const loggedIn = await step('login as operator lands on the floor home', async () => {
    op = await session('operator@dayson.test');
    await op.page.getByTestId('tile-receive').waitFor();
    const tiles = await op.page.locator('[data-testid^="tile-"]').count();
    eq(tiles, 8, 'operator tiles (no Kalite)');
    assert((await op.page.getByTestId('tile-qc').count()) === 0, 'operator must not see Kalite');
    await shot(op.page, '01-home-operator');
    return `${tiles} tiles`;
  });
  if (!loggedIn) return;

  await step('role guard: operator cannot open Kalite', async () => {
    await open(op.page, '/floor/qc');
    await op.page.getByText('Bu ekrana erişiminiz yok').waitFor();
    return 'no-access notice shown';
  });

  // ---- Mal Kabul ----------------------------------------------------------
  const received = await step('Mal Kabul: receive a pallet against the purchase order', async () => {
    const page = op.page;
    await open(page, '/floor/receive');
    await page.locator(`[data-testid="receive-doc"][data-doc-no="${run.poNo}"]`).waitFor();
    await shot(page, '02-receive-documents');
    // the document is chosen by scanning its number
    await scan(page, run.poNo);
    await page.getByTestId('receive-header').waitFor();
    // supplier GS1 label: (00) serial (01) gtin (17) expiry (11) production (10) lot
    await scan(page, `]d200${run.serial}01${run.gtin}17${yymmdd(run.expiry)}11${yymmdd(run.prod)}10${run.lot}`);
    await page.waitForFunction((lot) => document.querySelector('[data-testid="receive-lot"]')?.value === lot, run.lot);
    eq(await page.getByTestId('receive-expiry').inputValue(), run.expiry, 'expiry prefilled from (17)');
    eq(await page.getByTestId('receive-prod').inputValue(), run.prod, 'production date prefilled from (11)');
    // a label of another item is refused
    await scan(page, `]d201086900000100101726123110X`);
    await page.getByTestId('notice').filter({ hasText: 'Yanlış ürün' }).waitFor();
    // first pallet of the lot: the dock scan is refused until the weighed kg is entered
    await scan(page, 'TZ-DOCK-01');
    await page.getByTestId('notice').filter({ hasText: 'ağırlığını girin' }).waitFor();
    eq(sql1(`select count(*) from pallet where serial = '${run.serial}'`), 0, 'nothing posted without the weight');
    // a lane is not a dock
    await page.getByTestId('receive-kg').fill('905');
    await scan(page, 'TZ-B01-L01');
    await page.getByTestId('notice').filter({ hasText: 'rampa değil' }).waitFor();
    await shot(page, '03-receive-pallet-form', { full: true });
    await scan(page, 'TZ-DOCK-01');
    await page.getByTestId('receive-done').waitFor({ timeout: 20000 });
    eq(await text(page, 'receive-serial'), run.serial, 'serial on screen is the (00) of the label');
    run.putawayLane = await text(page, 'putaway-lane');
    // no PRINTER_HOST in this environment: the screen offers the ZPL download
    await page.waitForFunction(() => ['no_printer', 'printed'].includes(document.querySelector('[data-testid="label-status"]')?.getAttribute('data-status') ?? ''));
    const labelState = await page.getByTestId('label-status').getAttribute('data-status');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('label-download-btn').click()]);
    const zplPath = path.join(SHOTS, 'pallet-label.zpl');
    await download.saveAs(zplPath);
    const zpl = fs.readFileSync(zplPath, 'utf8');
    assert(zpl.startsWith('^XA') || zpl.includes('^XA'), 'downloaded file is ZPL');
    assert(zpl.includes(run.serial), 'ZPL carries the pallet serial');
    await shot(page, '04-receive-done-label', { full: true });
    // database
    const row = sql1(
      `select l.code, p.qty_base::int, lot.lot_no, lot.actual_pallet_kg::int, lot.expiry_date from pallet p join location l on l.id = p.location_id join lot on lot.id = p.lot_id where p.serial = '${run.serial}'`,
    );
    eq(row, `TZ-DOCK-01|${run.unitsPerPallet}|${run.lot}|905|${run.expiry}`, 'pallet row');
    run.lotId = sql1(`select lot_id from pallet where serial = '${run.serial}'`);
    eq(sql1(`select stock_status || '|' || qty_base::int from v_stock where lot_id = '${run.lotId}'`), `quarantine|${run.unitsPerPallet}`, 'stock is in quarantine at the dock');
    eq(sql1(`select received_qty::int || '|' || state from po_line where id = '${run.poLineId}'`), `${run.unitsPerPallet}|received`, 'po line');
    eq(sql1(`select txn_type from stock_txn where ref_doc_id = '${run.poLineId}'`), 'receipt_purchase', 'ledger transaction');
    eq(sql1(`select location_code from v_task where type = 'putaway' and pallet_serial = '${run.serial}'`), 'TZ-DOCK-01', 'put-away task created');
    return `pallet ${run.serial}, lot ${run.lot}, quarantine at TZ-DOCK-01, label ${labelState} + ZPL downloaded (${zpl.length} bytes), suggested ${run.putawayLane}`;
  });
  if (!received) return;

  await step('Mal Kabul: over-receipt is refused with APPROVAL_REQUIRED and explained', async () => {
    const page = op.page;
    await page.getByTestId('receive-next').click();
    await scan(page, 'TZ-DOCK-01');
    await page.getByTestId('approval-panel').waitFor({ timeout: 20000 });
    await page.getByTestId('notice').filter({ hasText: 'ikinci bir onay' }).waitFor();
    assert((await page.getByTestId('approval-panel').textContent()).includes('amir'), 'supervisor explanation');
    await shot(page, '05-receive-over-receipt', { full: true });
    eq(sql1(`select count(*) from pallet where lot_id = '${run.lotId}'`), 1, 'no second pallet posted');
    // the operator asks for the approval; it shows as pending
    await page.locator('[data-testid="approval-reasons"] [data-value="supplier_overship"]').click();
    await page.getByTestId('approval-request').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="approval-state"]')?.getAttribute('data-state') === 'pending');
    eq(sql1(`select state from approval_request where type = 'over_receipt' order by created_at desc limit 1`), 'pending', 'approval request');
    // the request is left pending on purpose: the main flow needs exactly one pallet of this lot
    await page.getByTestId('receive-back').click();
    return 'refused, panel shown, over_receipt request pending';
  });

  await step('scan log: confirmations and refusals reached scan_event', async () => {
    await waitOutboxEmpty(op.page);
    const rows = sql(`select accepted, count(*) from scan_event where screen = 'receive' and at > now() - interval '10 minutes' group by 1 order by 1`);
    assert(/f\|[1-9]/.test(rows) && /t\|[1-9]/.test(rows), `accepted and refused scans logged (${rows.replace(/\n/g, ' ')})`);
    return rows.replace(/\n/g, ', ');
  });

  await step('Görevlerim: put-away task is listed for the operator', async () => {
    const page = op.page;
    await open(page, '/floor/tasks');
    await page.getByTestId('task-group-putaway').waitFor();
    assert((await page.getByTestId('task-group-putaway').textContent()).includes('TZ-DOCK-01'), 'put-away task row');
    assert((await page.getByTestId('task-group-qc').count()) === 0, 'qc tasks are not shown to an operator');
    await shot(page, '06-tasks');
    return await text(page, 'tasks-outbox');
  });

  // ---- Kalite -------------------------------------------------------------
  let qc;
  const released = await step('Kalite: qc releases the lot', async () => {
    qc = await session('qc@dayson.test', '/floor/qc');
    const page = qc.page;
    const openBtn = page.locator(`[data-testid="qc-open"][data-lot="${run.lot}"]`);
    await openBtn.waitFor({ timeout: 20000 });
    assert(/saat|gün/.test(await page.getByTestId('qc-age').first().textContent()), 'age is shown');
    await openBtn.click();
    await page.getByTestId('qc-release').click();
    await shot(page, '07-qc');
    await page.getByTestId('qc-confirm').click();
    await page.getByTestId('notice').filter({ hasText: 'serbest bırakıldı' }).waitFor({ timeout: 20000 });
    eq(sql1(`select qc_status from lot where id = '${run.lotId}'`), 'released', 'lot.qc_status');
    eq(sql1(`select stock_status from v_stock where lot_id = '${run.lotId}'`), 'available', 'stock status');
    eq(sql1(`select count(*) from stock_txn where txn_type = 'qc_release' and ref_doc_id = '${run.lotId}'`), 1, 'qc_release transaction');
    return 'lot released, stock available';
  });
  if (!released) return;

  // ---- Yerleştirme ----------------------------------------------------------
  const putAway = await step('Yerleştirme: scan pallet, see the suggested lane, scan the lane', async () => {
    const page = op.page;
    await open(page, '/floor/putaway');
    await scan(page, run.serial);
    await page.getByTestId('putaway-suggestion').waitFor({ timeout: 20000 });
    const suggested = await text(page, 'putaway-lane');
    const expected = (await rpc('operator@dayson.test', 'rpc_putaway_suggestion', { p_pallet_serial: run.serial })).location;
    eq(suggested, expected, 'suggested lane equals rpc_putaway_suggestion');
    await shot(page, '08-putaway');
    // a lane holding another lot is refused by the lane rule
    const mixed = sql1(`select l.code from location l where l.type = 'block_lane' and l.lane_item_id is not null and l.lane_item_id <> '${run.itemId}' order by l.code limit 1`);
    await scan(page, mixed);
    await page.getByTestId('notice').filter({ hasText: 'başka ürün veya lot' }).waitFor({ timeout: 20000 });
    eq(sql1(`select l.code from pallet p join location l on l.id = p.location_id where p.serial = '${run.serial}'`), 'TZ-DOCK-01', 'pallet stays at the dock after LANE_MIXED');
    await scan(page, suggested);
    await page.getByTestId('putaway-done').waitFor({ timeout: 20000 });
    run.lane = suggested;
    eq(sql1(`select l.code from pallet p join location l on l.id = p.location_id where p.serial = '${run.serial}'`), suggested, 'pallet location');
    eq(sql1(`select count(*) from v_task where type = 'putaway' and pallet_serial = '${run.serial}'`), 0, 'put-away task closed');
    return `LANE_MIXED shown for ${mixed}; pallet now in ${suggested}`;
  });
  if (!putAway) return;

  // ---- order, allocation (planner, API) -------------------------------------
  const allocated = await step('planner (API): order saved, confirmed and allocated', async () => {
    const dealer = sql1(`select id from party where type = 'dealer' order by name limit 1`);
    const order = await rpc('planner@dayson.test', 'rpc_save_order', { p: { party_id: dealer, requested_date: today, lines: [{ item_id: run.itemId, qty: run.unitsPerPallet }] } });
    const confirmed = await rpc('planner@dayson.test', 'rpc_confirm_order', { p_order: order.order_id });
    run.shipmentId = confirmed.shipment_id;
    const alloc = await rpc('planner@dayson.test', 'rpc_allocate', { p_shipment: run.shipmentId });
    run.shipmentNo = sql1(`select shipment_no from shipment where id = '${run.shipmentId}'`);
    const task = sql1(`select id || '|' || location_code || '|' || lot_no from v_task where type = 'pick' and shipment_id = '${run.shipmentId}'`).split('|');
    assert(task.length === 3, `one pick task for the shipment (allocate: ${JSON.stringify(alloc)})`);
    run.pickTask = task[0];
    eq(task[1], run.lane, 'pick task lane is where the pallet was put away');
    eq(task[2], run.lot, 'pick task lot is the received lot (FEFO)');
    return `${run.shipmentNo}: pick ${task[1]} lot ${task[2]}`;
  });
  if (!allocated) return;

  // ---- Toplama --------------------------------------------------------------
  const picked = await step('Toplama: scan lane, pallet, staging', async () => {
    const page = op.page;
    await open(page, '/floor/pick');
    const truck = page.locator(`[data-testid="pick-truck"][data-shipment="${run.shipmentNo}"]`);
    await truck.waitFor({ timeout: 20000 });
    await shot(page, '09-pick-trucks');
    await truck.click();
    eq(await text(page, 'pick-lane'), run.lane, 'lane on the pick card');
    assert((await page.getByTestId('pick-task').textContent()).includes(run.lot), 'lot on the pick card');
    // a pallet before the lane is refused
    await scan(page, run.serial);
    await page.getByTestId('notice').filter({ hasText: 'Önce koridoru' }).waitFor();
    await scan(page, run.lane);
    // a pallet of another item is refused at once
    const other = sql1(`select p.serial from pallet p where p.status = 'active' and p.item_id <> '${run.itemId}' and p.shipment_id is null order by p.serial limit 1`);
    await scan(page, other);
    await page.getByTestId('notice').filter({ hasText: 'Yanlış' }).waitFor({ timeout: 20000 });
    await scan(page, run.serial);
    await page.locator('[data-step="pallet"][data-state="done"]').waitFor({ timeout: 20000 });
    await shot(page, '10-pick-scanning');
    await scan(page, 'TZ-STG-01');
    await page.getByTestId('pick-result').waitFor({ timeout: 20000 });
    eq(await page.locator('[data-testid="pick-result"] li').first().getAttribute('data-status'), 'done', 'pick line status');
    assert((await text(page, 'pick-remaining')).includes('0'), 'remaining is zero');
    await page.getByTestId('pick-truck-done').waitFor({ timeout: 20000 });
    await shot(page, '11-pick-done');
    eq(
      sql1(`select l.code || '|' || (p.shipment_id = '${run.shipmentId}') from pallet p join location l on l.id = p.location_id where p.serial = '${run.serial}'`),
      'TZ-STG-01|true',
      'pallet is staged for the truck',
    );
    eq(sql1(`select state from shipment where id = '${run.shipmentId}'`), 'picking', 'shipment state');
    eq(sql1(`select state from reservation where shipment_id = '${run.shipmentId}' and type = 'hard'`), 'consumed', 'hard reservation consumed');
    eq(sql1(`select count(*) from stock_txn where txn_type = 'pick' and ref_doc_id = '${run.shipmentId}'`), 1, 'pick transaction');
    return `pallet staged at TZ-STG-01, reservation consumed, shipment picking`;
  });
  if (!picked) return;

  // ---- Yükleme --------------------------------------------------------------
  const loaded = await step('Yükleme: scan truck and pallet, live panel', async () => {
    const page = op.page;
    await open(page, '/floor/load');
    await page.locator(`[data-testid="load-truck"][data-shipment="${run.shipmentNo}"]`).waitFor({ timeout: 20000 });
    await shot(page, '12-load-trucks');
    await scan(page, run.shipmentNo);
    await page.getByTestId('truck-panel').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="truck-pallets"]')?.textContent?.replace(/\s/g, '') === '0/1');
    assert((await text(page, 'unscanned-list')).includes(run.serial), 'unscanned pallet listed');
    // a pallet that is not for this truck
    const stranger = sql1(`select serial from pallet where status = 'active' and shipment_id is null order by serial limit 1`);
    await scan(page, stranger);
    await page.getByTestId('notice').filter({ hasText: 'bu tır için toplanmadı' }).waitFor();
    await scan(page, run.serial);
    await page.waitForFunction(() => document.querySelector('[data-testid="truck-pallets"]')?.textContent?.replace(/\s/g, '') === '1/1', null, { timeout: 20000 });
    const status = await rpc('operator@dayson.test', 'rpc_truck_status', { p_shipment: run.shipmentId });
    eq(status.loaded_kg, 905, 'running kg from the lot weight');
    assert((await text(page, 'truck-kg')).replace(/\D/g, '') === '905', 'running kg on screen');
    eq(await page.getByTestId('truck-window').getAttribute('data-in-window'), 'false', 'outside the weight window');
    assert((await text(page, 'truck-window')).includes('Alt sınıra'), 'distance to the window is shown');
    await page.getByTestId('all-loaded').waitFor();
    assert(sql1(`select loaded_at is not null from pallet where serial = '${run.serial}'`) === 't', 'pallet.loaded_at set');
    eq(sql1(`select state from shipment where id = '${run.shipmentId}'`), 'loading', 'shipment state');
    await shot(page, '13-load-panel', { full: true });
    return `1/1 pallets, ${status.loaded_kg} kg, window ${status.min_kg}–${status.max_kg}, ${await text(page, 'truck-window')}`;
  });
  if (!loaded) return;

  const refused = await step('Yükleme: close is refused outside the weight window', async () => {
    const page = op.page;
    assert(await page.getByTestId('close-truck').isDisabled(), 'close is disabled without the e-İrsaliye number');
    run.eirsaliye = `EIR${String(Date.now()).slice(-10)}`;
    await page.getByTestId('eirsaliye').fill(run.eirsaliye);
    await page.getByTestId('seal').fill('M-4471');
    await page.getByTestId('close-truck').click();
    await page.getByTestId('close-notice').filter({ hasText: 'izin verilen aralığın dışında' }).waitFor({ timeout: 30000 });
    await page.getByTestId('approval-panel').waitFor();
    eq(sql1(`select state from shipment where id = '${run.shipmentId}'`), 'loading', 'shipment not dispatched');
    return 'WEIGHT_OUT_OF_WINDOW shown in Turkish, shipment still loading';
  });
  if (!refused) return;

  const requested = await step('Yükleme: operator requests a weight override; it shows as pending', async () => {
    const page = op.page;
    await page.locator('[data-testid="approval-reasons"] [data-value="partial_truck"]').click();
    await page.getByTestId('approval-request').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="approval-state"]')?.getAttribute('data-state') === 'pending', null, { timeout: 20000 });
    run.approvalId = sql1(`select id from approval_request where type = 'weight_override' and entity_id = '${run.shipmentId}' and state = 'pending'`);
    assert(run.approvalId.length === 36, 'pending approval_request row');
    await shot(page, '14-load-override-pending', { full: true });
    return `approval_request ${run.approvalId} pending`;
  });
  if (!requested) return;

  const approved = await step('ops_manager (API) approves; the floor screen shows it', async () => {
    await rpc('ops_manager@dayson.test', 'rpc_decide_approval', { p_id: run.approvalId, p_approve: true, p_note: 'e2e' });
    await op.page.waitForFunction(() => document.querySelector('[data-testid="approval-state"]')?.getAttribute('data-state') === 'approved', null, { timeout: 20000 });
    return 'state approved on screen without a reload';
  });
  if (!approved) return;

  await step('Yükleme: truck closes and the shipment is dispatched', async () => {
    const page = op.page;
    const t0 = Date.now();
    await page.getByTestId('close-truck').click();
    await page.getByTestId('truck-closed').waitFor({ timeout: 30000 });
    run.closeMs = Date.now() - t0;
    await shot(page, '15-load-dispatched');
    eq(sql1(`select state || '|' || e_irsaliye_no || '|' || seal_no from shipment where id = '${run.shipmentId}'`), `dispatched|${run.eirsaliye}|M-4471`, 'shipment');
    eq(sql1(`select count(*) from stock_txn where txn_type = 'ship' and ref_doc_id = '${run.shipmentId}'`), 1, 'one ship transaction');
    eq(sql1(`select coalesce(sum(qty_base), 0)::int from stock_balance b join location l on l.id = b.location_id where b.lot_id = '${run.lotId}' and l.type <> 'virtual'`), 0, 'lot left the warehouse');
    eq(sql1(`select window_ok || '|' || (override_by is not null) from truck_load where shipment_id = '${run.shipmentId}'`), 'false|true', 'truck load records the override');
    eq(sql1(`select count(*) from export_row where type = 'shipment_confirm' and ref_id = '${run.shipmentId}'`), 1, 'shipment confirmation for Logo');
    return `shipment ${run.shipmentNo} dispatched with e-İrsaliye ${run.eirsaliye} (${run.closeMs} ms from tap to confirmation)`;
  });
}

// ---- Sayım ------------------------------------------------------------------
async function countFlow() {
  const lanes = sql(
    `select l.code || '|' || count(p.*) || '|' || coalesce(sum(p.qty_base), 0)::int from location l join pallet p on p.location_id = l.id and p.status = 'active' where l.type = 'block_lane' and l.lane_item_id is not null and not exists (select 1 from count_task ct where ct.location_id = l.id and ct.state in ('open', 'recount', 'pending_approval')) and not exists (select 1 from reservation r where r.location_id = l.id and r.state = 'active') group by l.code having count(p.*) >= 2 order by l.code limit 2`,
  )
    .split('\n')
    .map((r) => r.split('|'));
  if (lanes.length < 2) throw new Error('need two stocked lanes without an open count');
  const [a, b] = lanes;
  let op;

  const ok = await step('Sayım: blind count inside tolerance closes the task', async () => {
    const taskId = await rpc('ops_manager@dayson.test', 'rpc_create_count_task', { p_location: a[0], p_trigger: 'scheduled' });
    op = await session('operator@dayson.test', '/floor/count');
    const page = op.page;
    await page.locator(`[data-testid="count-task"][data-location="${a[0]}"]`).click();
    await page.getByTestId('count-header').waitFor();
    // blind: neither the expected pallets nor the expected units appear anywhere
    const body = (await page.locator('main').textContent()) ?? '';
    assert(!body.includes(a[2]) && !new RegExp(`\\b${Number(a[2]).toLocaleString('tr-TR')}\\b`).test(body), 'expected quantity is not on the screen');
    const viewCols = sql1(`select string_agg(column_name, ',') from information_schema.columns where table_name = 'v_count_task_blind'`);
    assert(!/expected|variance/.test(viewCols), 'the blind view has no expected / variance column');
    await scan(page, b[0]);
    await page.getByTestId('notice').filter({ hasText: 'Yanlış lokasyon' }).waitFor();
    await scan(page, a[0]);
    await page.getByTestId('count-qty').fill(a[1]);
    await shot(page, '16-count', { full: true });
    await page.getByTestId('count-submit').click();
    await page.getByTestId('count-result').waitFor({ timeout: 20000 });
    eq(await page.getByTestId('count-result').getAttribute('data-state'), 'closed', 'result on screen');
    eq(sql1(`select state || '|' || within_tolerance || '|' || counted_qty::int from count_task where id = '${taskId}'`), `closed|true|${a[2]}`, 'count_task');
    return `${a[0]}: counted ${a[1]} pallets -> closed`;
  });
  if (!ok) return;

  await step('Sayım: a variance asks for a recount by a different user', async () => {
    const page = op.page;
    const taskId = await rpc('ops_manager@dayson.test', 'rpc_create_count_task', { p_location: b[0], p_trigger: 'exception' });
    run.recountTask = taskId;
    await page.getByTestId('refresh').click();
    await page.locator(`[data-testid="count-task"][data-location="${b[0]}"]`).click();
    await scan(page, b[0]);
    await page.getByTestId('count-qty').fill(String(Number(b[1]) - 1));
    await page.getByTestId('count-submit').click();
    await page.getByTestId('count-result').waitFor({ timeout: 20000 });
    eq(await page.getByTestId('count-result').getAttribute('data-state'), 'recount', 'result on screen');
    await shot(page, '17-count-recount-needed');
    eq(sql1(`select state from count_task where id = '${taskId}'`), 'recount', 'count_task.state');
    // the same user may not recount
    await page.locator(`[data-testid="count-task"][data-location="${b[0]}"][data-state="recount"]`).click();
    await page.getByTestId('count-same-user').waitFor();
    return `${b[0]}: counted ${Number(b[1]) - 1} of a different quantity -> recount; same user is blocked`;
  });

  await step('Sayım: operator2 recounts with a reason; the task closes', async () => {
    const op2 = await session('operator2@dayson.test', '/floor/count');
    const page = op2.page;
    await page.locator(`[data-testid="count-task"][data-location="${b[0]}"][data-state="recount"]`).click();
    await scan(page, b[0]);
    await page.getByTestId('count-qty').fill(b[1]);
    assert(await page.getByTestId('count-submit').isDisabled(), 'a recount needs a reason');
    await page.locator('[data-testid="count-reasons"] [data-value="miscount"]').click();
    await shot(page, '18-count-recount', { full: true });
    await page.getByTestId('count-submit').click();
    await page.getByTestId('count-result').waitFor({ timeout: 20000 });
    eq(await page.getByTestId('count-result').getAttribute('data-state'), 'closed', 'result on screen');
    eq(sql1(`select state || '|' || within_tolerance || '|' || (recount_by <> counted_by) from count_task where id = '${run.recountTask}'`), 'closed|true|true', 'count_task');
    return `${b[0]}: recount ${b[1]} pallets by operator2 -> closed, no adjustment`;
  });
}

// ---- Sorgu ------------------------------------------------------------------
async function queryFlow() {
  await step('Sorgu: pallet, location, item and unknown code', async () => {
    const { page } = await session('operator@dayson.test', '/floor/query');
    const row = sql1(
      `select p.serial || '|' || l.code || '|' || i.sku || '|' || lot.lot_no || '|' || i.gtin from pallet p join location l on l.id = p.location_id join item i on i.id = p.item_id join lot on lot.id = p.lot_id where p.status = 'active' and l.type = 'block_lane' order by p.serial limit 1`,
    ).split('|');
    await scan(page, row[0]);
    await page.getByTestId('query-pallet').waitFor({ timeout: 20000 });
    eq(await text(page, 'query-location'), row[1], 'pallet location');
    eq(await text(page, 'query-sku'), row[2], 'pallet item');
    eq(await text(page, 'query-lot'), row[3], 'pallet lot');
    await shot(page, '19-query-pallet', { full: true });
    await scan(page, row[1]);
    await page.getByTestId('query-location-card').waitFor({ timeout: 20000 });
    assert((await page.getByTestId('query-location-card').textContent()).includes(row[0]), 'location lists the pallet');
    await shot(page, '20-query-location');
    await scan(page, `${GS}01${row[4]}10${row[3]}`);
    await page.getByTestId('query-item').waitFor({ timeout: 20000 });
    assert((await page.getByTestId('query-item').textContent()).includes(row[1]), 'item stock lists the lane');
    await shot(page, '21-query-item');
    await scan(page, '???');
    await page.getByText('sistemde bulunamadı').waitFor();
    return `pallet ${row[0]} -> ${row[1]} / ${row[2]} / ${row[3]}; location and GS1 item lookups shown; unknown refused`;
  });
}

// ---- offline ----------------------------------------------------------------
async function offlineFlow() {
  await step('offline: a transfer is queued, replayed once when the network returns', async () => {
    const pick = sql1(
      `select p.serial || '|' || l.code from pallet p join location l on l.id = p.location_id where p.status = 'active' and p.shipment_id is null and l.type = 'block_lane' and not exists (select 1 from reservation r where r.location_id = l.id and r.state = 'active') and (select count(*) from pallet x where x.location_id = l.id and x.status = 'active') >= 2 order by p.serial desc limit 1`,
    ).split('|');
    const empty = sql1(
      `select l.code from location l where l.type = 'block_lane' and l.active and l.lane_item_id is null and not exists (select 1 from stock_balance b where b.location_id = l.id and b.qty_base > 0) order by l.code desc limit 1`,
    );
    const [serial, from] = pick;
    const txns = () => Number(sql1(`select count(*) from stock_txn where txn_type = 'transfer' and ref_doc_id = '${serial}'`));
    const where = () => sql1(`select l.code from pallet p join location l on l.id = p.location_id where p.serial = '${serial}'`);
    const before = txns();
    const since = sql1('select now()');

    const { page, context } = await session('operator@dayson.test', '/floor/transfer');
    await page.getByTestId('scan-flow').waitFor();
    await waitOutboxEmpty(page);
    await context.setOffline(true);
    await page.waitForFunction(() => document.querySelector('[data-testid="connection"]')?.textContent?.includes('Çevrimdışı'));
    await scan(page, from);
    await scan(page, serial);
    await scan(page, empty);
    await page.locator('[data-testid="transfer-result"][data-status="queued"]').waitFor({ timeout: 20000 });
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="outbox-count"]')?.textContent ?? '0') >= 1);
    const queued = Number(await text(page, 'outbox-count'));
    await page.waitForTimeout(2500); // the scan-log batch joins the queue
    await shot(page, '22-transfer-offline-queued');
    eq(where(), from, 'nothing moved while offline');
    eq(txns(), before, 'nothing posted while offline');

    await context.setOffline(false);
    await waitOutboxEmpty(page, 30000);
    eq(where(), empty, 'pallet moved after the replay');
    eq(txns(), before + 1, 'the move was posted exactly once');
    const sent = sql1(`select count(*) from command_log where cmd = 'transfer' and args->>'pallet_serial' = '${serial}' and created_at > '${since}'`);
    eq(sent, 1, 'one command in command_log');
    const eventAt = sql1(`select (t.event_at < t.created_at) from stock_txn t where txn_type = 'transfer' and ref_doc_id = '${serial}' order by created_at desc limit 1`);
    await page.waitForFunction(() => document.querySelector('[data-testid="connection"]')?.textContent?.includes('Çevrimiçi'));
    await shot(page, '23-transfer-online-drained');
    await open(page, '/floor/outbox');
    await shot(page, '24-outbox');
    // put the pallet back so the seed lanes stay as they were
    const back = await floorCmd('operator@dayson.test', 'transfer', { pallet_serial: serial, from_location: empty, to_location: from });
    assert(!back.error, `restore move: ${JSON.stringify(back).slice(0, 200)}`);
    return `${serial}: ${from} -> ${empty}; queued counter ${queued}; after reconnect 1 transfer txn (event_at before created_at: ${eventAt}); moved back`;
  });
}

// ---- Bayi (sales rep) ---------------------------------------------------------
async function dealerFlow() {
  await step('sales rep: floor home shows Sayım, Sorgu and Bayi; a stock observation is recorded', async () => {
    const { page } = await session('sales_rep@dayson.test', '/floor');
    await page.getByTestId('tile-dealer').waitFor({ timeout: 20000 });
    const tiles = (await page.locator('[data-testid^="tile-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).join(',');
    eq(tiles, 'tile-tasks,tile-count,tile-query,tile-dealer', 'rep tiles');
    await shot(page, '25-home-sales-rep');
    await page.getByTestId('tile-dealer').click();
    await page.getByTestId('dealer').first().waitFor({ timeout: 20000 });
    eq(await page.getByTestId('dealer').count(), Number(sql1(`select count(*) from rep_dealer rd join auth.users u on u.id = rd.user_id where u.email = 'sales_rep@dayson.test'`)), 'only own dealers');
    const dealerName = (await page.getByTestId('dealer').first().textContent()).trim();
    await page.getByTestId('dealer').first().click();
    await page.getByTestId('dealer-item').first().click();
    const qty = 40 + Math.floor(Math.random() * 50);
    await page.getByTestId('dealer-qty').fill(String(qty));
    await shot(page, '26-dealer-observation', { full: true });
    await page.getByTestId('dealer-submit').click();
    await page.getByTestId('notice').filter({ hasText: 'Gözlem kaydedildi' }).waitFor({ timeout: 20000 });
    const row = sql1(
      `select o.qty::int || '|' || o.source || '|' || p.name from dealer_stock_observation o join party p on p.id = o.party_id order by o.created_at desc limit 1`,
    );
    eq(row, `${qty}|rep_visual|${dealerName}`, 'dealer_stock_observation');
    return row;
  });
}

try {
  await main();
  if (!failed) {
    await countFlow().catch((err) => step('Sayım', () => Promise.reject(err)));
    await queryFlow();
    await offlineFlow();
    await dealerFlow();
  }
} catch (err) {
  failed = true;
  console.log(`FATAL ${err instanceof Error ? err.stack : err}`);
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close().catch(() => {});
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed} / ${results.length} steps passed. Screenshots: ${SHOTS}`);
fs.writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify({ run, results }, null, 2));
process.exit(failed || passed !== results.length ? 1 : 0);
