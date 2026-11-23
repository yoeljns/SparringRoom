'use client';

import type { ReactNode } from 'react';
import type { Row } from '@/lib/data/office-db';
import { L, T } from './i18n';
import type { Lookups } from './lookups';
import { Button, Field, Select, inputCls } from './ui';

interface Schema {
  type?: string;
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  description?: string;
}

const SEGMENTS = ['A', 'B', 'C'];

function numOrUndef(text: string): number | string | undefined {
  const s = text.trim().replace(',', '.');
  if (s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : text;
}

function NumberInput({ value, onChange, name }: { value: unknown; onChange: (v: number | string | undefined) => void; name?: string }) {
  return <input name={name} inputMode="decimal" className={inputCls} value={value === undefined || value === null ? '' : String(value)} onChange={(e) => onChange(numOrUndef(e.target.value))} />;
}

function MultiItems({ value, onChange, lookups, name }: { value: unknown; onChange: (v: string[] | undefined) => void; lookups: Lookups; name?: string }) {
  const selected = Array.isArray(value) ? value.map(String) : [];
  return (
    <select name={name} multiple size={5} className={`${inputCls} h-28 py-1`} value={selected} onChange={(e) => {
      const next = Array.from(e.target.selectedOptions, (o) => o.value);
      onChange(next.length ? next : undefined);
    }}>
      {lookups.options('item').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** A value per dealer segment (targets, seed quantities). */
function SegmentMap({ value, onChange, name }: { value: unknown; onChange: (v: Row | undefined) => void; name: string }) {
  const obj = value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
  return (
    <div className="grid grid-cols-3 gap-2">
      {SEGMENTS.map((s) => (
        <label key={s} className="text-xs text-muted">
          {T('schema.segment', { s })}
          <NumberInput name={`${name}.${s}`} value={obj[s]} onChange={(v) => {
            const next = { ...obj };
            if (v === undefined) delete next[s];
            else next[s] = v;
            onChange(Object.keys(next).length ? next : undefined);
          }} />
        </label>
      ))}
    </div>
  );
}

/** Item rule of a mechanic (family, attributes, explicit items); all given conditions must hold. */
export function ItemRuleEditor({ value, onChange, lookups, name }: { value: unknown; onChange: (v: Row | undefined) => void; lookups: Lookups; name: string }) {
  const rule = value && typeof value === 'object' ? (value as Row) : {};
  const set = (patch: Row) => {
    const next: Row = { ...rule, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === '') delete next[k];
    onChange(Object.keys(next).length ? next : undefined);
  };
  const attrsText = rule.attrs ? Object.entries(rule.attrs as Row).map(([k, v]) => `${k}=${v}`).join(', ') : '';
  return (
    <div className="grid grid-cols-1 gap-2 rounded-md border border-line bg-surface p-3 md:grid-cols-2">
      <Field label={T('schema.family')}>
        <Select name={`${name}.family_code`} value={String(rule.family_code ?? '')} onChange={(v) => set({ family_code: v || undefined })} options={lookups.list('family').map((f) => ({ value: String(f.code), label: `${f.code} · ${f.name}` }))} placeholder={T('schema.anyFamily')} />
      </Field>
      <Field label={T('schema.attrs')} hint={T('schema.attrsHint')}>
        <input name={`${name}.attrs`} className={inputCls} defaultValue={attrsText} onBlur={(e) => set({ attrs: parseAttrs(e.target.value) })} />
      </Field>
      <Field label={T('schema.items')} hint={T('schema.multiHint')} className="md:col-span-2">
        <MultiItems name={`${name}.item_ids`} value={rule.item_ids} lookups={lookups} onChange={(v) => set({ item_ids: v })} />
      </Field>
    </div>
  );
}

/** "colour=Beyaz, volume_ml=600" to an object; numbers and booleans are typed. */
export function parseAttrs(text: string): Row | undefined {
  const out: Row = {};
  for (const part of text.split(',')) {
    const [k, ...rest] = part.split('=');
    const key = k.trim();
    const raw = rest.join('=').trim();
    if (!key || raw === '') continue;
    out[key] = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return Object.keys(out).length ? out : undefined;
}

function ObjectList({ schema, value, onChange, name }: { schema: Schema; value: unknown; onChange: (v: Row[] | undefined) => void; name: string }) {
  const list = Array.isArray(value) ? (value as Row[]) : [];
  const keys = Object.keys(schema.properties ?? {});
  return (
    <div className="space-y-2">
      {list.map((row, i) => (
        <div key={i} className="flex items-end gap-2">
          {keys.map((k) => (
            <label key={k} className="flex-1 text-xs text-muted">
              {L(k)}
              <NumberInput name={`${name}.${i}.${k}`} value={row[k]} onChange={(v) => onChange(list.map((r, j) => (j === i ? { ...r, [k]: v } : r)))} />
            </label>
          ))}
          <Button small variant="ghost" onClick={() => onChange(list.filter((_, j) => j !== i))}>{T('c.remove')}</Button>
        </div>
      ))}
      <Button small variant="ghost" onClick={() => onChange([...list, {}])} data-testid={`${name}-add`}>{T('c.addRow')}</Button>
    </div>
  );
}

function JsonArea({ value, onChange, name }: { value: unknown; onChange: (v: unknown) => void; name: string }) {
  const text = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <textarea name={name} rows={3} className={`${inputCls} py-2 font-mono text-xs`} defaultValue={text} onBlur={(e) => {
      const s = e.target.value.trim();
      if (!s) return onChange(undefined);
      try {
        onChange(JSON.parse(s));
      } catch {
        onChange(s);
      }
    }} />
  );
}

/**
 * Form generated from a JSON Schema (item_family.attr_schema, mechanic_type.param_schema).
 * Property names that refer to master data get a select box instead of a text field.
 */
export function SchemaForm({ schema, value, onChange, lookups, prefix = 'p' }: {
  schema: Schema | null | undefined; value: Row; onChange: (next: Row) => void; lookups: Lookups; prefix?: string;
}) {
  const props = Object.entries(schema?.properties ?? {});
  if (props.length === 0) return <p className="text-sm text-muted">{T('schema.none')}</p>;
  const required = new Set(schema?.required ?? []);
  const set = (key: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined || v === '') delete next[key];
    else next[key] = v;
    onChange(next);
  };
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {props.map(([key, p]) => {
        const name = `${prefix}.${key}`;
        const label = L(key) + (required.has(key) ? ' *' : '');
        const v = value[key];
        let control: ReactNode;
        let wide = false;
        if (p.enum) {
          control = <Select name={name} value={String(v ?? '')} onChange={(x) => set(key, x)} options={p.enum.map((e) => ({ value: String(e), label: String(e) }))} />;
        } else if (key === 'free_item' || key === 'gift_item' || key === 'item') {
          const opts = lookups.options('item', key === 'gift_item' ? (r) => r.sellable === false : undefined);
          control = <Select name={name} value={String(v ?? '')} onChange={(x) => set(key, x)} options={key === 'free_item' ? [{ value: 'same', label: T('schema.sameItem') }, ...opts] : opts} />;
        } else if (key === 'bundle_id') {
          control = <Select name={name} value={String(v ?? '')} onChange={(x) => set(key, x)} options={lookups.options('bundle')} />;
        } else if (key === 'market') {
          control = <Select name={name} value={String(v ?? '')} onChange={(x) => set(key, x)} options={lookups.list('market').map((m) => ({ value: String(m.code), label: `${m.code} · ${m.name}` }))} />;
        } else if (key === 'buy_item_rule') {
          wide = true;
          control = <ItemRuleEditor name={name} value={v} onChange={(x) => set(key, x)} lookups={lookups} />;
        } else if (key === 'period') {
          const per = v && typeof v === 'object' ? (v as Row) : {};
          control = (
            <div className="flex gap-2">
              <input type="date" name={`${name}.from`} className={inputCls} value={String(per.from ?? '')} onChange={(e) => set(key, { ...per, from: e.target.value })} />
              <input type="date" name={`${name}.to`} className={inputCls} value={String(per.to ?? '')} onChange={(e) => set(key, { ...per, to: e.target.value })} />
            </div>
          );
        } else if (key === 'targets' || key === 'seed_qty') {
          wide = true;
          control = <SegmentMap name={name} value={v} onChange={(x) => set(key, x)} />;
        } else if (p.type === 'array' && p.items?.type === 'string') {
          wide = true;
          control = <MultiItems name={name} value={v} lookups={lookups} onChange={(x) => set(key, x)} />;
        } else if (p.type === 'array' && p.items?.properties) {
          wide = true;
          control = <ObjectList name={name} schema={p.items} value={v} onChange={(x) => set(key, x)} />;
        } else if (p.type === 'number' || p.type === 'integer') {
          control = <NumberInput name={name} value={v} onChange={(x) => set(key, x)} />;
        } else if (p.type === 'boolean') {
          control = <input type="checkbox" name={name} checked={v === true} onChange={(e) => set(key, e.target.checked)} className="h-4 w-4" />;
        } else if (p.type === 'string') {
          control = <input name={name} className={inputCls} value={String(v ?? '')} onChange={(e) => set(key, e.target.value)} />;
        } else {
          wide = true;
          control = <JsonArea name={name} value={v} onChange={(x) => set(key, x)} />;
        }
        return (
          <Field key={key} label={label} hint={p.description} className={wide ? 'md:col-span-2' : ''}>
            {control}
          </Field>
        );
      })}
    </div>
  );
}
