# Sensoria Admin Dashboard

Full-stack control plane for **aacsensoria.id** — devices, subscriptions,
QRIS transactions, and system configuration. Next.js (App Router) +
Tailwind + Recharts, themed to the landing page's Deep Slate / Teal glass
design.

## Modules

| Route | Module |
|---|---|
| `/admin` | Executive analytics — MRR/ARR (gross & net of refunds), active paid vs trial, pending vs settled, revenue growth, daily active devices, **10% developer royalty ledger (net-based)** |
| `/admin/lookup` | Support lookup — one search (pairing code / device id / child name / **parent name or phone**) → unified timeline: subscription history, payments, recent **addresses**. A parent contact hit also surfaces the linked children (one click to the child's story). Owner can purge a child's location data on request and run a single **audited emergency locate** (raw GPS + map) when a child's safety requires it |
| `/admin/transactions` | QRIS ledger — status/date filters, manual override (with confirm), webhook settlement replay, **Owner-only manual-gateway refunds with automatic entitlement claw-back**, refund history, CSV export, raw-payload drawer |
| `/admin/devices` | Device fleet — child profiles, **parent slots used/max + family contact**, linked children for parent rows, entitlement state, +7d/+30d trial extension, plan revocation (with confirm dialog). **Click any row → the full dossier** (same shared panel as Lookup): linked-parent cards with phone numbers, linked children, timeline, payments, addresses, emergency locate, purge, Owner **+1-slot grant** |
| `/admin/subscriptions` | Plan pricing control (Owner) for **combo plans AND one-time parent-slot packs**, paywall availability, stacking preview (+1 month projection), **royalty settlement ledger — mark-paid + CSV statement per month (Owner)** |
| `/admin/settings` | `web_payment_active` stealth kill-switch, maintenance mode, announcement banner, trial/grace windows (**Owner only**) |
| `/admin/team` | Admin roster — roles (Owner/Support), invite by email (Supabase invite flow), last sign-in, role hand-over (**mutations Owner only**) |
| `/admin/audit` | Append-only audit trail — every override, revocation, extension, plan/settings edit, team change, and sign-in attempt (who/what/when/IP) |

## Data-flow alignment with the mobile app

The dashboard and the Expo app (`src/`) share one Postgres; these are the
contract points to respect in every dashboard change:

| Data flow | Mobile side (src/) | Dashboard side (admin/) | Rule |
|---|---|---|---|
| **Entitlement** | `services/db/entitlement.ts` + realtime on `subscriptions` | devices/subscriptions pages edit rows | Never invent status values; edits target the newest row per child; date edits keep the raw boundary semantics (trial mirrors into `expires_at`) |
| **Money ledger** | app NEVER writes `transactions` (verified — zero INSERT call sites) | webhook/settle/override/refund own this table | Refunds go through the `refund_transaction` RPC — v2 is slot-pack-aware (slot refunds decrement `max_parent_slots`, floor 1; combo refunds shorten duration per `apply_plan_purchase`, 30.4375-day month) |
| **Parent slots & contacts** | `PairingBottomSheet` upserts `family_links` (enforced against `max_parent_slots` by DB trigger — no app change needed); `child_devices` holds the parent's phone | dossier shows linked parents WITH device identity + phone; slots column `used/max`; QRIS backend calls `apply_parent_slot_purchase()` for slot packs | Slots are PERMANENT one-time purchases (default 1 free slot); contact rows auto-sync from `family_links` and disappear with the last unlink |
| **Location** | child writes `locations` + live `devices` presence columns | dashboard reads **addresses only** | Raw coordinates exist in exactly one place: `getEmergencyLocation()` → Owner-only, reason-mandatory, audited `emergency_locate` |
| **Privacy erasure** | app reads live columns for the parent map | purge action NULLs presence columns, deletes history | After a purge the parent map shows “no location yet” — expected, not a bug |

## Security model

- **Auth**: Supabase Auth (email/password). Middleware (`admin/middleware.ts`)
  refreshes sessions and bounces anonymous visitors; `lib/auth.ts` then checks
  the session email against the `admin_users` allowlist (service role).
  Both checks must pass — the cookie alone is never trusted.
- **Service role**: `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS and is imported
  ONLY by server modules (`lib/*`, `app/**/actions.ts`, server pages). It
  never ships to the browser.
- **RLS**: enabled on the NEW tables (`transactions`, `admin_users`) via
  `supabase/migrations/20260911_admin_transactions.sql`, guarded by
  `is_admin()`. Existing tables stay open for the mobile app (anon) and are
  touched by the dashboard exclusively through the server-side service role.
- **Roles**: `admin_users.role` is `owner` or `support`
  (`20260913_admin_roles.sql`). Support handles ops (devices, extend/revoke,
  read money); pricing, ledger overrides, settings, and the team page are
  Owner-only (`requireOwner()` in `lib/auth.ts`). The DB keeps exactly ONE
  Owner via the `enforce_single_owner` trigger — the dashboard can never
  lock itself out of pricing controls.

## First-run setup

1. Run `supabase/migrations/20260911_admin_transactions.sql`,
   `supabase/migrations/20260913_admin_audit_log.sql`,
   `20260913_admin_roles.sql`, `20260913_telegram_paid_notifications.sql`,
   `20260913_location_retention.sql`, `20260913_manual_refunds.sql`,
   `20260913_royalty_payments.sql`, and
   `20260913_telegram_alerts_digest.sql` in the Supabase SQL Editor (all
   idempotent). The roles migration promotes the first allowlisted email to
   Owner automatically.
3. Run the family/slot set (also idempotent):
   `20260913_parent_contacts.sql` (child_devices registry + sync triggers +
   backfill), `20260913_parent_slot_packs.sql` (plans.kind/slot_count +
   `apply_parent_slot_purchase` RPC + the Rp 25.000 "Slot Parent +1" seed),
   `20260913_parent_slot_enforcement.sql` (DB-level family_links capacity
   trigger — closes the unlimited-linking loophole for every writer), and
   `20260913_refund_slot_aware.sql` (refund RPC v2).
2. Create the admin auth user (Supabase Dashboard → Authentication → Users →
   Add user), then allowlist it:
   ```sql
   INSERT INTO public.admin_users (email) VALUES ('you@aacsensoria.id');
   ```
   (After the first Owner exists, invite further admins from `/admin/team`
   instead — no SQL needed.)
3. `cp .env.example .env.local` and fill the three keys (Project Settings →
   API).
4. `npm install && npm run dev` → http://localhost:3100/admin

## Security hardening (MFA, password policy, audit log)

See **[`lib/SECURITY.md`](lib/SECURITY.md)** for the operator runbook: enable
Supabase MFA (TOTP) and flip `ADMIN_ENFORCE_MFA`, set the Supabase password
policy (12+ chars, character classes, leaked-password protection), and how the
login rate limiter and `admin_audit_log` retention work.

## Paid-transaction notifications (Telegram)

`20260913_telegram_paid_notifications.sql` makes the database ping Telegram
the moment a transaction settles (`pending → paid`, via pg_net). One-time
setup, in the SQL editor:

```sql
ALTER DATABASE postgres SET app.telegram_bot_token = '<token from @BotFather>';
ALTER DATABASE postgres SET app.telegram_chat_id  = '<your chat id>';
```

(Send the bot any message, then read the chat id from
`api.telegram.org/bot<TOKEN>/getUpdates`.) Secrets live in the server settings
file — never in a table, never in the repo. Test with the verification queries
at the bottom of the migration file.

With `20260913_telegram_alerts_digest.sql` the same bot also sends:

- **Stale-pending alert** — any transaction pending > 1 hour pings once
  (15-minute sweep). A silent webhook can no longer eat a paid QRIS unnoticed.
- **Weekly digest** — Monday 08:00 WIB: MTD gross/refunded/net, settled &
  pending counts, fleet sizes.

## Manual refunds & royalty settlement

- Refunds are **manual in the gateway dashboard**; the dashboard only records
  them (Owner-only, `refunds` table) and claws the entitlement back
  atomically: last purchase → plan revoked; stacked purchase → expiry
  shortened by the refunded plan's duration. Executive royalty is computed
  from **net** revenue (paid − refunded).
- The monthly 10% developer royalty is settled via “Mark paid” on the
  Subscriptions page (Owner-only, `royalty_payments` table) with a
  downloadable CSV statement per month as proof.

## Child data privacy (Play Families)

- **Raw GPS coordinates are never rendered in the dashboard.** The lookup
  dossier carries reverse-geocoded `address` text only
  (`lib/lookup.ts` selects address + timestamp, never lat/long).
- **Retention**: `locations` history is pruned after 30 days by pg_cron
  (`20260913_location_retention.sql`).
- **Erasure on request**: Owner-only “Purge locations” on `/admin/lookup`
  deletes the child's GPS history rows and nulls the device's live
  coordinates (`last_seen` is kept for fleet stats). Every purge is written
  to the append-only audit log (`privacy_purge_locations`).

## Deployment (VPS / aaPanel)

```bash
cd admin
npm ci
npm run build
npm start          # serves on :3100; reverse-proxy aacsensoria.id/admin → 127.0.0.1:3100
```

Run it under pm2 (`pm2 start "npm start" --name sensoria-admin`) and terminate
TLS at the aaPanel site. Restrict `/admin` to the reverse proxy — never expose
port 3100 directly.
