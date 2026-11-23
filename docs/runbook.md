# Runbook

For whoever has to keep the system running without the owner.

## Where things run
- Database, auth, file buckets: Supabase project (EU). Daily backups with point-in-time recovery must be enabled in
  Supabase (Database → Backups); test a restore each quarter into a scratch project.
- Web app and cron routes: Vercel project `apps/web`. Crons: daily digest 04:00 UTC (07:00 Istanbul), alert push every 5 min.
- Planning worker: GitHub Actions `nightly.yml`, 22:00 UTC (01:00 Istanbul). Logs in the Actions run; job results in table `job_run`.
- Floor devices: Zebra TC22, Chrome, the app installed from `/floor` (Add to Home screen). DataWedge profile: keystroke
  output, Enter suffix, send the AIM symbology identifier, "Send Characters as Events", inter-key delay about 50 ms.

## Daily
- 07:00 digest by email / Telegram. Anything red there is a task: reconciliation differences older than 48 h, expiry-blocked
  lots awaiting a decision, late inbound orders, approvals waiting.
- Logo files: inbound files are uploaded in **Mutabakat** (or dropped in bucket `logo-in`); outbound files are built there
  and handed to the Logo users. A file is imported once (hash); a file with an unknown column is rejected whole; a file
  with a bad row is held and nothing from it is applied — fix the file and upload it again.

## Something is wrong
| Symptom | Check | Action |
| --- | --- | --- |
| Alert "ledger_rebuild_mismatch" | `select rpc_rebuild_check();` | Stop stock movements; compare `stock_balance` with `sum(stock_move)` for the sample rows; never edit ledger rows — post a `reversal` or `count_adjust`. Restore from backup only as a last resort. |
| Nightly job failed (alert) | `select * from job_run order by started_at desc limit 20;` | Fix the cause, rerun: Planlama → İşler → run job, or `uv run python -m dayson_worker.cli nightly`. Plans from the previous night stay valid; nothing is overwritten. |
| Floor app cannot post | Outbox counter on the device; `select * from alert order by created_at desc limit 20;` | Commands queue offline and replay in order when the network returns. A refused command shows in the rejected list with its reason. |
| Wrong stock posted | Stok → hareketler | Post a reversal (ops manager) with a reason code. A transaction can be reversed once. |
| Truck will not close | Yükleme screen shows why: weight window, unscanned pallet, missing e-İrsaliye number | Weight override: operator requests, ops manager approves in Onaylar. |
| Import rejected | Mutabakat → içe aktarma geçmişi | Compare the header with `contracts/v1/<type>.json`. |
| User locked out / new user | Supabase → Authentication | Create or reset the user, then assign the role in Ana Veriler → Kullanıcılar (owner only). |

## Restore service from nothing
1. New Supabase project in an EU region, restore the latest backup into it (or `supabase db push` + data restore).
2. Point Vercel env vars and the worker's `DATABASE_URL` at the new project; redeploy.
3. `select rpc_rebuild_check();` must return 0 differences before the floor resumes.
4. Devices need no change if the app URL is the same.

## Changing rules
All thresholds are effective-dated rows in `planning_param`. Planners propose, the owner approves (Onaylar); the old
row is kept with its end date. One-off exceptions on a lot, order or shipment are `param_override` rows created through
approval requests.

## Schema changes
Add a new numbered file in `supabase/migrations`; never edit a merged one. `bash scripts/dev-db.sh test` must pass
locally and in CI before `migrate.yml` is run against staging, then production.

## Personal data (KVKK)
Scan logs and per-user compliance are personal data: readable by owner and ops manager only, deleted after
`scan_log_retention_days`. An employee information notice must be issued before go-live; hosting outside Türkiye is an
open legal point (spec §15).
