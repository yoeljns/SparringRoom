/**
 * Logo Tiger CSV contract v1 (spec section 11).
 *
 * File rules (11.1): name <type>_<YYYYMMDD>_<seq>.csv, first line
 * "#schema=v1", second line the header, semicolon separator, dot decimal,
 * ISO dates, UTF-8. A file with an unknown or missing column or an unknown
 * schema version is rejected whole. Row errors are reported per row; a file
 * with any row error is held for review and never partially applied.
 *
 * The JSON files in /contracts/v1 are generated from this module
 * (pnpm --filter domain gen) and checked by a test.
 */

export const LOGO_SCHEMA_VERSION = 'v1';
export const LOGO_SEPARATOR = ';';

export type LogoColumnType = 'string' | 'decimal' | 'date' | 'datetime' | 'boolean' | 'enum' | 'period';

export interface LogoColumn {
  name: string;
  type: LogoColumnType;
  required: boolean;
  /** Allowed values for type "enum". */
  values?: readonly string[];
  note?: string;
}

export interface LogoFileContract {
  type: string;
  direction: 'inbound' | 'outbound';
  description: string;
  columns: readonly LogoColumn[];
}

const col = (
  name: string,
  type: LogoColumnType = 'string',
  required = true,
  extra: Partial<LogoColumn> = {},
): LogoColumn => ({ name, type, required, ...extra });

export const LOGO_CONTRACTS = {
  // ---- 11.2 Inbound from Logo -------------------------------------------
  items: {
    type: 'items',
    direction: 'inbound',
    description: 'Detect new or changed items; never overwrites attributes kept here',
    columns: [
      col('logo_item_code'),
      col('name'),
      col('unit'),
      col('gtin', 'string', false, { note: '8, 12, 13 or 14 digits' }),
      col('active', 'boolean'),
    ],
  },
  parties: {
    type: 'parties',
    direction: 'inbound',
    description: 'Party master sync',
    columns: [
      col('logo_cari_code'),
      col('name'),
      col('vkn', 'string', false),
      col('type'),
      col('city', 'string', false),
      col('country'),
      col('active', 'boolean'),
    ],
  },
  sales_docs: {
    type: 'sales_docs',
    direction: 'inbound',
    description: 'Demand history, shipment matching, reconciliation',
    columns: [
      col('doc_type', 'enum', true, { values: ['irsaliye', 'invoice'] }),
      col('doc_no'),
      col('doc_date', 'date'),
      col('logo_cari_code'),
      col('logo_item_code'),
      col('qty', 'decimal'),
      col('unit'),
      col('unit_price_eur', 'decimal', false),
      col('is_free', 'boolean'),
      col('e_irsaliye_no', 'string', false),
      col('ref_shipment_id', 'string', false),
    ],
  },
  purchase_docs: {
    type: 'purchase_docs',
    direction: 'inbound',
    description: 'Receipt matching',
    columns: [
      col('doc_no'),
      col('doc_date', 'date'),
      col('logo_cari_code'),
      col('logo_item_code'),
      col('qty', 'decimal'),
      col('unit'),
    ],
  },
  stock_snapshot: {
    type: 'stock_snapshot',
    direction: 'inbound',
    description: 'Daily reconciliation',
    columns: [
      col('as_of', 'datetime', true, { note: 'ISO date or ISO date-time with offset: the cut-off' }),
      col('logo_item_code'),
      col('warehouse_code'),
      col('qty', 'decimal'),
      col('unit'),
    ],
  },
  item_cost: {
    type: 'item_cost',
    direction: 'inbound',
    description: 'ABC value ranking and EUR alert thresholds only',
    columns: [col('logo_item_code'), col('cost_eur', 'decimal'), col('as_of', 'date')],
  },
  // ---- 11.3 Outbound to Logo users --------------------------------------
  shipment_confirm: {
    type: 'shipment_confirm',
    direction: 'outbound',
    description: 'Create e-Irsaliye and invoice; return doc numbers through sales_docs',
    columns: [
      col('shipment_id'),
      col('ship_date', 'date'),
      col('logo_cari_code'),
      col('logo_item_code'),
      col('qty', 'decimal'),
      col('unit'),
      col('lot_no'),
      col('line_type', 'enum', true, { values: ['paid', 'free'] }),
      col('campaign_code', 'string', false),
    ],
  },
  receipts: {
    type: 'receipts',
    direction: 'outbound',
    description: 'Book purchase or production receipt',
    columns: [
      col('receipt_id'),
      col('date', 'date'),
      col('supplier_code'),
      col('logo_item_code'),
      col('qty', 'decimal'),
      col('lot_no'),
    ],
  },
  adjustments: {
    type: 'adjustments',
    direction: 'outbound',
    description: 'Book count differences and scrap',
    columns: [
      col('txn_id'),
      col('date', 'date'),
      col('logo_item_code'),
      col('qty_signed', 'decimal'),
      col('reason_code'),
      col('approved_by', 'string', false),
    ],
  },
  consignment_sales: {
    type: 'consignment_sales',
    direction: 'outbound',
    description: 'Invoice consignment consumption',
    columns: [
      col('dealer_code'),
      col('logo_item_code'),
      col('qty', 'decimal'),
      col('period', 'period', true, { note: 'YYYY-MM' }),
    ],
  },
  campaign_settlement: {
    type: 'campaign_settlement',
    direction: 'outbound',
    description: 'Book rebates and free-goods totals',
    columns: [
      col('campaign_code'),
      col('dealer_code'),
      col('type', 'enum', true, { values: ['rebate', 'free_goods_total'] }),
      col('amount_eur', 'decimal', false, { note: 'filled when type = rebate' }),
      col('qty', 'decimal', false, { note: 'filled when type = free_goods_total' }),
    ],
  },
} as const satisfies Record<string, LogoFileContract>;

export type LogoFileType = keyof typeof LOGO_CONTRACTS;

export const LOGO_FILE_TYPES = Object.keys(LOGO_CONTRACTS) as LogoFileType[];
export const LOGO_INBOUND_TYPES = LOGO_FILE_TYPES.filter((t) => LOGO_CONTRACTS[t].direction === 'inbound');
export const LOGO_OUTBOUND_TYPES = LOGO_FILE_TYPES.filter((t) => LOGO_CONTRACTS[t].direction === 'outbound');

export function isLogoFileType(value: string): value is LogoFileType {
  return Object.prototype.hasOwnProperty.call(LOGO_CONTRACTS, value);
}

export function logoColumnNames(type: LogoFileType): string[] {
  return LOGO_CONTRACTS[type].columns.map((c) => c.name);
}

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

const FILE_NAME_RE = /^([a-z][a-z_]*)_(\d{8})_(\d{1,6})\.csv$/;

export interface LogoFileName {
  type: LogoFileType;
  /** ISO date taken from the name. */
  date: string;
  seq: number;
}

function isValidIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** Parse "<type>_<YYYYMMDD>_<seq>.csv"; null when the name does not follow the rule. */
export function parseLogoFileName(name: string): LogoFileName | null {
  const base = name.split('/').pop() ?? name;
  const m = FILE_NAME_RE.exec(base);
  if (!m || !isLogoFileType(m[1])) return null;
  const date = `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6, 8)}`;
  if (!isValidIsoDate(date)) return null;
  return { type: m[1], date, seq: Number(m[3]) };
}

export function logoFileName(type: LogoFileType, date: string, seq: number): string {
  if (!isValidIsoDate(date)) throw new Error(`logoFileName: not an ISO date: ${date}`);
  if (!Number.isInteger(seq) || seq < 0 || seq > 999999) throw new Error('logoFileName: seq out of range');
  return `${type}_${date.replace(/-/g, '')}_${String(seq).padStart(3, '0')}.csv`;
}

// ---------------------------------------------------------------------------
// CSV reading and writing
// ---------------------------------------------------------------------------

/** Split CSV text into records; supports quoted fields with doubled quotes. */
export function splitCsv(text: string, separator = LOGO_SEPARATOR): { line: number; cells: string[] }[] {
  const out: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let sawAny = false;
  const pushRecord = () => {
    cells.push(cell);
    if (sawAny) out.push({ line: recordLine, cells });
    cells = [];
    cell = '';
    sawAny = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.length === 0) {
      quoted = true;
      sawAny = true;
    } else if (ch === separator) {
      cells.push(cell);
      cell = '';
      sawAny = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      pushRecord();
      line++;
      recordLine = line;
    } else {
      cell += ch;
      sawAny = true;
    }
  }
  if (sawAny || cell.length > 0 || cells.length > 0) pushRecord();
  return out;
}

function csvCell(value: string): string {
  return /[";\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Returns an error code or null when the cell fits its column. */
export function validateLogoCell(column: LogoColumn, value: string): string | null {
  if (value === '') return column.required ? 'REQUIRED' : null;
  switch (column.type) {
    case 'string':
      return null;
    case 'decimal':
      return DECIMAL_RE.test(value) ? null : 'BAD_DECIMAL';
    case 'date':
      return isValidIsoDate(value) ? null : 'BAD_DATE';
    case 'datetime':
      return isValidIsoDate(value) || (DATETIME_RE.test(value) && isValidIsoDate(value.slice(0, 10)))
        ? null
        : 'BAD_DATETIME';
    case 'boolean':
      return ['true', 'false', '1', '0'].includes(value) ? null : 'BAD_BOOLEAN';
    case 'enum':
      return column.values?.includes(value) ? null : 'BAD_ENUM';
    case 'period':
      return PERIOD_RE.test(value) ? null : 'BAD_PERIOD';
  }
}

export function parseLogoBoolean(value: string): boolean {
  return value === 'true' || value === '1';
}

export type LogoRow = Record<string, string>;

export interface LogoFileError {
  /** "file": the whole file is rejected. "row": the file is held for review. */
  level: 'file' | 'row';
  code: string;
  message: string;
  /** 1-based line in the file. */
  line?: number;
  column?: string;
}

export interface ParsedLogoFile {
  type: LogoFileType | null;
  /** ISO date from the file name. */
  date: string | null;
  seq: number | null;
  schemaVersion: string | null;
  header: string[];
  /** Empty when the file is rejected. Values are the raw strings; '' = empty. */
  rows: LogoRow[];
  errors: LogoFileError[];
  /** True when a file-level error rejects the whole file. */
  rejected: boolean;
  /** True when there are no errors of any level. */
  ok: boolean;
}

/**
 * Parse and validate a Logo exchange file. Never throws.
 * Any file-level error (name, schema version, unknown/missing/duplicate
 * column) rejects the whole file and returns no rows.
 */
export function parseLogoFile(name: string, text: string): ParsedLogoFile {
  const errors: LogoFileError[] = [];
  const parsedName = parseLogoFileName(name);
  const result: ParsedLogoFile = {
    type: parsedName?.type ?? null,
    date: parsedName?.date ?? null,
    seq: parsedName?.seq ?? null,
    schemaVersion: null,
    header: [],
    rows: [],
    errors,
    rejected: false,
    ok: false,
  };
  const reject = (code: string, message: string, column?: string): ParsedLogoFile => {
    errors.push({ level: 'file', code, message, column });
    result.rejected = true;
    result.rows = [];
    return result;
  };

  if (!parsedName) return reject('BAD_FILE_NAME', `File name must be <type>_<YYYYMMDD>_<seq>.csv with a known type: ${name}`);

  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstBreak = body.search(/\r?\n/);
  const firstLine = (firstBreak === -1 ? body : body.slice(0, firstBreak)).trim();
  const schema = /^#schema=(.+)$/.exec(firstLine);
  if (!schema) return reject('MISSING_SCHEMA_LINE', 'First line must be #schema=v1');
  result.schemaVersion = schema[1].trim();
  if (result.schemaVersion !== LOGO_SCHEMA_VERSION) {
    return reject('UNKNOWN_SCHEMA_VERSION', `Unknown schema version: ${result.schemaVersion}`);
  }

  const rest = firstBreak === -1 ? '' : body.slice(firstBreak).replace(/^\r?\n/, '');
  // Line numbers are 1-based in the whole file; the header is line 2.
  const records = splitCsv(rest).map((r) => ({ line: r.line + 1, cells: r.cells }));
  if (records.length === 0) return reject('MISSING_HEADER', 'Second line must be the header');

  const header = records[0].cells.map((c) => c.trim());
  result.header = header;
  const columns: readonly LogoColumn[] = LOGO_CONTRACTS[parsedName.type].columns;
  const expected = columns.map((c) => c.name);

  const seen = new Set<string>();
  for (const h of header) {
    if (!expected.includes(h)) errors.push({ level: 'file', code: 'UNKNOWN_COLUMN', message: `Unknown column: ${h}`, column: h });
    else if (seen.has(h)) errors.push({ level: 'file', code: 'DUPLICATE_COLUMN', message: `Duplicate column: ${h}`, column: h });
    seen.add(h);
  }
  for (const e of expected) {
    if (!seen.has(e)) errors.push({ level: 'file', code: 'MISSING_COLUMN', message: `Missing column: ${e}`, column: e });
  }
  if (errors.length > 0) {
    result.rejected = true;
    return result;
  }

  const byName = new Map(columns.map((c) => [c.name, c]));
  const rows: LogoRow[] = [];
  for (const record of records.slice(1)) {
    if (record.cells.length !== header.length) {
      errors.push({
        level: 'row',
        code: 'WRONG_CELL_COUNT',
        message: `Expected ${header.length} cells, found ${record.cells.length}`,
        line: record.line,
      });
      continue;
    }
    const row: LogoRow = {};
    header.forEach((h, idx) => {
      const value = record.cells[idx].trim();
      row[h] = value;
      const code = validateLogoCell(byName.get(h)!, value);
      if (code) errors.push({ level: 'row', code, message: `${h}: ${code}`, line: record.line, column: h });
    });
    rows.push(row);
  }
  result.rows = rows;
  result.ok = errors.length === 0;
  return result;
}

export type LogoRowInput = Record<string, string | number | boolean | null | undefined>;

function cellToString(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('buildLogoFile: non-finite number');
    // Plain decimal notation, never an exponent; numeric(14,3) fits.
    return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  }
  return String(value);
}

/**
 * Build an exchange file (used for the outbound files). Throws when a row
 * has an unknown column or a value that breaks the contract, so a bad file
 * is never written.
 */
export function buildLogoFile(
  type: LogoFileType,
  date: string,
  seq: number,
  rows: readonly LogoRowInput[],
): { name: string; text: string } {
  const columns: readonly LogoColumn[] = LOGO_CONTRACTS[type].columns;
  const names = columns.map((c) => c.name);
  const lines = [`#schema=${LOGO_SCHEMA_VERSION}`, names.join(LOGO_SEPARATOR)];
  rows.forEach((row, idx) => {
    for (const key of Object.keys(row)) {
      if (!names.includes(key)) throw new Error(`buildLogoFile(${type}) row ${idx + 1}: unknown column ${key}`);
    }
    const cells = columns.map((c) => {
      const value = cellToString(row[c.name]);
      const code = validateLogoCell(c, value);
      if (code) throw new Error(`buildLogoFile(${type}) row ${idx + 1}: ${c.name}: ${code}`);
      return csvCell(value);
    });
    lines.push(cells.join(LOGO_SEPARATOR));
  });
  return { name: logoFileName(type, date, seq), text: lines.join('\n') + '\n' };
}

/** SHA-256 of the UTF-8 bytes, lower-case hex (Web Crypto; browser and Node). */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** JSON document written to /contracts/v1/<type>.json. */
export function logoContractJson(type: LogoFileType) {
  const c: LogoFileContract = LOGO_CONTRACTS[type];
  return {
    schema: LOGO_SCHEMA_VERSION,
    type: c.type,
    direction: c.direction,
    description: c.description,
    file_name: '<type>_<YYYYMMDD>_<seq>.csv',
    first_line: `#schema=${LOGO_SCHEMA_VERSION}`,
    encoding: 'UTF-8',
    separator: LOGO_SEPARATOR,
    decimal: '.',
    date_format: 'YYYY-MM-DD',
    columns: c.columns.map((x) => ({
      name: x.name,
      type: x.type,
      required: x.required,
      ...(x.values ? { values: [...x.values] } : {}),
      ...(x.note ? { note: x.note } : {}),
    })),
  };
}
