'use client';

import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import type { Row } from '@/lib/data/office-db';
import { useAction } from './hooks';
import { E, L, T } from './i18n';
import type { LookupName, Lookups } from './lookups';
import { Button, Field, Modal, Notice, Select, inputCls, type Option } from './ui';

export interface FieldDef {
  key: string;
  label?: string;
  type?: 'text' | 'number' | 'int' | 'bool' | 'date' | 'select' | 'lookup' | 'json' | 'textarea';
  /** select: enumerated values (translated through office.enum) or ready options. */
  options?: readonly string[] | readonly Option[];
  lookup?: LookupName;
  lookupFilter?: (r: Row) => boolean;
  required?: boolean;
  hint?: string;
  wide?: boolean;
  /** Cannot be changed once the row exists. */
  lockOnEdit?: boolean;
  min?: number;
  show?: (values: FormValues) => boolean;
}

export type FormValues = Record<string, string | boolean>;

export function toFormValues(fields: readonly FieldDef[], row: Row | null | undefined): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
    const v = row?.[f.key];
    if (f.type === 'bool') out[f.key] = v === true;
    else if (f.type === 'json') out[f.key] = v === null || v === undefined ? '' : JSON.stringify(v, null, 2);
    else out[f.key] = v === null || v === undefined ? '' : String(v);
  }
  return out;
}

/** zod schema generated from the field list; empty optional values become null. */
export function schemaFor(fields: readonly FieldDef[]): z.ZodType<Row> {
  const shape: Record<string, z.ZodType> = {};
  for (const f of fields) {
    const req = T('c.required');
    if (f.type === 'bool') {
      shape[f.key] = z.boolean();
    } else if (f.type === 'number' || f.type === 'int') {
      shape[f.key] = z.string().transform((s, ctx) => {
        const text = s.trim().replace(',', '.');
        if (text === '') {
          if (f.required) ctx.addIssue({ code: 'custom', message: req });
          return null;
        }
        const n = Number(text);
        if (!Number.isFinite(n) || (f.type === 'int' && !Number.isInteger(n))) {
          ctx.addIssue({ code: 'custom', message: T('c.invalidNumber') });
          return null;
        }
        if (f.min !== undefined && n < f.min) ctx.addIssue({ code: 'custom', message: T('c.minValue', { n: f.min }) });
        return n;
      });
    } else if (f.type === 'json') {
      shape[f.key] = z.string().transform((s, ctx) => {
        if (s.trim() === '') {
          if (f.required) ctx.addIssue({ code: 'custom', message: req });
          return null;
        }
        try {
          return JSON.parse(s) as unknown;
        } catch {
          ctx.addIssue({ code: 'custom', message: T('c.invalidJson') });
          return null;
        }
      });
    } else if (f.type === 'date') {
      shape[f.key] = z.string().transform((s, ctx) => {
        if (s === '') {
          if (f.required) ctx.addIssue({ code: 'custom', message: req });
          return null;
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) ctx.addIssue({ code: 'custom', message: T('c.invalidDate') });
        return s;
      });
    } else {
      shape[f.key] = z.string().transform((s, ctx) => {
        const text = s.trim();
        if (text === '') {
          if (f.required) ctx.addIssue({ code: 'custom', message: req });
          return null;
        }
        return text;
      });
    }
  }
  return z.object(shape) as unknown as z.ZodType<Row>;
}

export function validateForm(fields: readonly FieldDef[], values: FormValues): { data?: Row; errors: Record<string, string> } {
  const active = fields.filter((f) => !f.show || f.show(values));
  const parsed = schemaFor(active).safeParse(values);
  if (parsed.success) return { data: parsed.data, errors: {} };
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const k = String(issue.path[0] ?? '');
    if (!errors[k]) errors[k] = issue.message;
  }
  return { errors };
}

function fieldOptions(f: FieldDef, lk?: Lookups): Option[] {
  if (f.type === 'lookup' && f.lookup) return lk?.options(f.lookup, f.lookupFilter) ?? [];
  return (f.options ?? []).map((o) => (typeof o === 'string' ? { value: o, label: E(o) } : o));
}

export function FormFields({ fields, values, onChange, errors, lookups, editing }: {
  fields: readonly FieldDef[]; values: FormValues; onChange: (key: string, value: string | boolean) => void;
  errors?: Record<string, string>; lookups?: Lookups; editing?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {fields.filter((f) => !f.show || f.show(values)).map((f) => {
        const label = (f.label ?? L(f.key)) + (f.required ? ' *' : '');
        const disabled = !!(editing && f.lockOnEdit);
        const v = values[f.key];
        const span = f.wide || f.type === 'json' || f.type === 'textarea' ? 'md:col-span-2' : '';
        if (f.type === 'bool') {
          return (
            <label key={f.key} className={`flex min-h-10 items-center gap-2 self-end text-sm ${span}`}>
              <input type="checkbox" name={f.key} checked={v === true} disabled={disabled} onChange={(e) => onChange(f.key, e.target.checked)} className="h-4 w-4 accent-[var(--color-brand)]" />
              <span className="font-medium text-ink-soft">{label}</span>
            </label>
          );
        }
        return (
          <Field key={f.key} label={label} error={errors?.[f.key]} hint={f.hint} className={span}>
            {f.type === 'select' || f.type === 'lookup' ? (
              <Select name={f.key} value={String(v ?? '')} disabled={disabled} onChange={(x) => onChange(f.key, x)} options={fieldOptions(f, lookups)} />
            ) : f.type === 'json' || f.type === 'textarea' ? (
              <textarea name={f.key} value={String(v ?? '')} disabled={disabled} onChange={(e) => onChange(f.key, e.target.value)} rows={f.type === 'json' ? 4 : 3} className={`${inputCls} py-2 ${f.type === 'json' ? 'font-mono text-xs' : ''}`} />
            ) : (
              <input
                name={f.key}
                type={f.type === 'date' ? 'date' : 'text'}
                inputMode={f.type === 'number' || f.type === 'int' ? 'decimal' : undefined}
                value={String(v ?? '')}
                disabled={disabled}
                onChange={(e) => onChange(f.key, e.target.value)}
                className={inputCls}
              />
            )}
          </Field>
        );
      })}
    </div>
  );
}

/** Modal form: client validation (zod), then `onSubmit`; a refusal is shown in Turkish. */
export function FormModal({ title, fields, initial, onSubmit, onClose, lookups, editing, children, submitLabel, wide }: {
  title: string; fields: readonly FieldDef[]; initial?: Row | null; onSubmit: (data: Row) => Promise<void>; onClose: () => void;
  lookups?: Lookups; editing?: boolean; children?: ReactNode; submitLabel?: string; wide?: boolean;
}) {
  const [values, setValues] = useState<FormValues>(() => toFormValues(fields, initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const action = useAction();
  const submit = () => {
    const { data, errors: found } = validateForm(fields, values);
    setErrors(found);
    if (!data) return;
    void action.run(() => onSubmit(data));
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      wide={wide}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{T('c.cancel')}</Button>
          <Button variant="primary" disabled={action.busy} onClick={submit} data-testid="form-submit">{submitLabel ?? T('c.save')}</Button>
        </>
      }
    >
      <FormFields fields={fields} values={values} errors={errors} lookups={lookups} editing={editing} onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))} />
      {children}
      <Notice>{action.error}</Notice>
    </Modal>
  );
}

/** Asks for a reason / note before a write. */
export function ReasonModal({ title, label, required = true, confirmLabel, onSubmit, onClose, children }: {
  title: string; label?: string; required?: boolean; confirmLabel?: string; onSubmit: (reason: string) => Promise<void>; onClose: () => void; children?: ReactNode;
}) {
  return (
    <FormModal
      title={title}
      fields={[{ key: 'reason', label: label ?? T('c.reason'), type: 'textarea', required }]}
      submitLabel={confirmLabel ?? T('c.confirm')}
      onClose={onClose}
      onSubmit={(d) => onSubmit(String(d.reason ?? ''))}
    >
      {children}
    </FormModal>
  );
}
