# Dayson Inventory System — conventions

Spec: `docs/build-spec-v1.pdf`. API contract: `docs/api.md`. Operations: `docs/runbook.md`. Supabase setup: `docs/supabase-setup.md`.

## Layout
- `apps/web` — Next.js (App Router, TypeScript): `(office)` back office and `/floor` PWA for the Zebra TC22.
- `packages/domain` — scan/GS1 parser, Logo CSV contract, campaign mechanic `explode` mirrors, roles, label rendering.
- `supabase/migrations` — numbered SQL, never edited after merge to main; add a new file instead.
- `supabase/tests` — pgTAP tests (`shim/` holds local-only stand-ins for Supabase's auth schema and roles).
- `worker` — Python 3.12 planning worker (one module per job), `worker/mechanics` one file per campaign mechanic.
- `labels` — ZPL templates. `contracts` — Logo CSV schemas v1 and samples. `scripts/dev-db.sh`, `scripts/dev-api` — local harness.

## Rules that must hold
- Stock changes only through `post_txn` / `rpc_floor`. Never insert into `stock_move`; never update or delete ledger rows.
- Every business write is a database function (`rpc_*`). Tables are read-only for API roles; RLS is on every table.
- Reserved quantity lives only in `reservation`. Available-to-reserve is the view `v_available`, never a stored column.
- No operational constant in code: read values with `resolve_param(name, context)`; add a `planning_param` row instead.
- Table and column names in English snake_case. UI strings in Turkish, all in `apps/web/src/i18n/tr.json`.
- Quantities are base units in `numeric(14,3)`; weights in kg; timestamps `timestamptz` UTC, shown in Europe/Istanbul.
- Every table has `id uuid`, `created_at`, `created_by`; mutable tables add `updated_at` and `app.track()` (audit trigger).
- Business errors: `app.fail('CODE', detail)`; clients switch on the code prefix. `post_txn`/`rpc_floor` return `{error}`.
- A new campaign mechanic = one Python module in `worker/mechanics`, its TypeScript `explode` mirror, its schema row, tests.
- No service key in client code. Secrets only in the host's vault (Vercel env, GitHub secrets).

## Commands
- `bash scripts/dev-db.sh test` — reset a local Postgres 16, apply shim + migrations, run all pgTAP tests + concurrency test.
- `bash scripts/dev-db.sh reset` — local database with demo seed. `DB_NAME=x` selects another database.
- `bash scripts/dev-api/start.sh` — local Supabase-like API on :54321 (dev users `<role>@dayson.test` / `dayson123`).
- `pnpm install && pnpm --filter web dev` — web app. `pnpm -r test`, `pnpm -r typecheck`, `pnpm --filter web build`.
- `cd worker && uv run pytest` — worker tests.
