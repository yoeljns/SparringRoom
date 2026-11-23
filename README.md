# Dayson Inventory System

Standalone inventory system for Dayson, built from `docs/build-spec-v1.pdf`: an append-only stock ledger on Supabase
Postgres, a warehouse floor PWA for Zebra TC22 handhelds, a Turkish back office, a Python planning worker, a campaign
engine, dealer consignment and estimates, and a daily CSV exchange with Logo Tiger.

| Part | Where | What |
| --- | --- | --- |
| Database | `supabase/migrations` | Ledger (`post_txn`), masters, orders, ATP, allocation, truck close, counts, planning, campaigns, approvals, Logo exchange, reconciliation, row-level security |
| Web | `apps/web` | Back office and `/floor` PWA (Next.js, TypeScript) |
| Shared | `packages/domain` | GS1/scan parsing, Logo CSV contract, campaign mechanics, roles, labels |
| Worker | `worker` | Nightly planning jobs, truck load planner (OR-Tools), campaign simulation |
| Labels, contracts | `labels`, `contracts` | ZPL templates; Logo CSV schemas v1 with samples |

Start with `docs/supabase-setup.md` to connect a Supabase project. Conventions are in `CLAUDE.md`, the database API in
`docs/api.md`, operations in `docs/runbook.md`.

## Local development (no Supabase project needed)

```bash
bash scripts/dev-db.sh test
```

```bash
bash scripts/dev-api/start.sh
```

```bash
pnpm install && pnpm --filter web dev
```

The second command seeds a demo database and serves a Supabase-like API on `http://127.0.0.1:54321`; put that URL in
`apps/web/.env.local` (see `apps/web/.env.example`). Demo users are `<role>@dayson.test` with password `dayson123`
(owner, ops_manager, operator, qc, planner, sales_rep, finance, auditor). The dev API is a small emulation for local
use only; production uses Supabase itself.
