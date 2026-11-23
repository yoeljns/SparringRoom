# Connecting Supabase, Vercel and the worker

The code was developed against a plain local Postgres 16 with a small stand-in for Supabase's `auth` schema and API
roles (`supabase/tests/shim`). It has not yet been run on a real Supabase project: follow the steps below and run the
checks at the end.

## 1. Create the project
1. Supabase dashboard → New project → region **EU** (Frankfurt, `eu-central-1`). Keep the database password.
2. Do **not** run anything from `supabase/tests/shim/` on it. Those files are for local Postgres only.

## 2. Apply the migrations
With the Supabase CLI (`npm i -g supabase`):

```bash
supabase link --project-ref <project-ref>
```

```bash
supabase db push
```

This applies `supabase/migrations/0001…` in order. They create the tables, functions, row-level security, the two
storage buckets (`logo-in`, `logo-out`) and the reference data (transaction types, parameters, mechanic types, approval
rules, Logo file contract). The spec asks for migrations to run through CI only: the workflow
`.github/workflows/migrate.yml` does the same `db push` from GitHub once the secrets below are set.

Optional demo data (11 sealant items with the spec's pallet weights, lanes, dealers, two years of synthetic demand,
opening stock): run `supabase/seed.sql` once in the SQL editor on a **staging** project. Do not load it into production.

## 3. First user
1. Authentication → Users → Add user (email + password) for yourself.
2. Sign in to the app. The first signed-in user registers as owner by calling `rpc_set_user` (the login screen offers
   this when no user row exists), or run in the SQL editor:
   `insert into app_user (id, full_name, role) values ('<auth user id>', 'Ad Soyad', 'owner');`
3. Create the other users in Authentication, then assign roles in **Ana Veriler → Kullanıcılar**.

## 4. Web app on Vercel
Project root `apps/web`. Environment variables:

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon / publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key (server only: cron routes) |
| `CRON_SECRET` | random string; Vercel sends it to the cron routes |
| `APP_URL` | public URL of the app, used in digest links |
| `RESEND_API_KEY`, `DIGEST_EMAIL_FROM`, `DIGEST_EMAIL_TO` | email digest (optional) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram digest and alerts (optional) |
| `PRINTER_HOST`, `PRINTER_PORT` | Zebra ZD230T address (see below) |

Label printing: a Vercel function cannot reach a printer on the warehouse LAN. Either expose the printer through a
tunnel/VPN, run a second instance of the app inside the warehouse network with `PRINTER_HOST` set, or use the
"ZPL indir" download that every print button offers.

## 5. Planning worker
Runs nightly from `.github/workflows/nightly.yml` (or any container host) with:

| Secret | Value |
| --- | --- |
| `DATABASE_URL` | Supabase connection string (session pooler, port 5432), user `postgres` |

The worker connects directly to Postgres, so it acts as the system role. Run `serve` on an always-on host if truck
plans and campaign simulations should come back within minutes instead of at the next scheduled run.

## 6. Checks after connecting
- `select rpc_rebuild_check();` returns `{"differences": 0}`.
- Sign in as an operator: `select * from count_task` returns nothing (blind counts); direct `insert` into any table fails.
- Upload `contracts/samples/items_*.csv` in **Mutabakat** twice: first `applied`, then `skipped`.
- Things that differ from the local stand-in and are worth one look: `auth.uid()` and `request.jwt.claims` come from
  Supabase itself; `storage.objects` policies for the two buckets; default privileges of `anon` / `authenticated`
  (migration 0011 revokes them explicitly).

## Open inputs
The placeholders in spec §15 are rows in `planning_param` (Planlama → Parametreler): shelf life, MRSL per market,
truck window, tolerances, EUR approval threshold, GS1 company prefix. Changing them needs no code.
