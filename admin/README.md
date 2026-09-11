# Sensoria Admin Dashboard

Full-stack control plane for **aacsensoria.id** — devices, subscriptions,
QRIS transactions, and system configuration. Next.js (App Router) +
Tailwind + Recharts, themed to the landing page's Deep Slate / Teal glass
design.

## Modules

| Route | Module |
|---|---|
| `/admin` | Executive analytics — MRR/ARR, active paid vs trial, pending vs settled, revenue growth, daily active devices, **10% developer royalty ledger** |
| `/admin/transactions` | QRIS ledger — status/date filters, manual override, webhook settlement replay, CSV export, raw-payload drawer |
| `/admin/devices` | Device fleet — child profiles, linked parents, entitlement state, +7d trial extension, plan revocation |
| `/admin/subscriptions` | Plan pricing/duration control, paywall availability, stacking preview (+1 month projection) |
| `/admin/settings` | `web_payment_active` stealth kill-switch, maintenance mode, announcement banner, trial/grace windows |

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

## First-run setup

1. Run `supabase/migrations/20260911_admin_transactions.sql` in the Supabase
   SQL Editor (idempotent).
2. Create the admin auth user (Supabase Dashboard → Authentication → Users →
   Add user), then allowlist it:
   ```sql
   INSERT INTO public.admin_users (email) VALUES ('you@aacsensoria.id');
   ```
3. `cp .env.example .env.local` and fill the three keys (Project Settings →
   API).
4. `npm install && npm run dev` → http://localhost:3100/admin

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
