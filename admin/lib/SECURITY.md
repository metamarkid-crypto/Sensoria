# Admin Dashboard — Security Hardening Guide

Operator runbook for the Sensoria admin control plane (`/admin`). Covers the
login hardening shipped in this repo plus the Supabase Dashboard steps that
cannot be done from code.

---

## 1. Enable MFA for admin accounts (Supabase MFA, TOTP)

Code side, enforcement is flag-gated: `ADMIN_ENFORCE_MFA` in
`admin/lib/auth.ts`. It is **false** by default so existing admins are not
locked out before enrolling. The dashboard shows an amber banner until every
signed-in admin reaches AAL2.

### Step-by-step

1. **Turn the feature on in Supabase** — Dashboard → your project →
   **Authentication → Multi-Factor Auth** → enable **App Authenticator (TOTP)**.
   Keep *Phone* off unless you actually use SMS factors. Leave
   "Certificate / Verification" settings at their defaults (verification
   enabled) — a "Disabled" setting silently turns the challenge APIs off.
2. **Enroll every admin** — sign in at `/admin/login`, click the banner's
   **Open MFA settings** link (or Authentication → Users → ⋯ → *Enroll MFA
   factor* in newer dashboards), and scan the QR code with an authenticator
   app (Aegis, 1Password, Google Authenticator…). Verify the 6-digit code to
   finish enrollment. Each admin repeats this from their own browser.
3. **Flip the enforcement flag** — set `ADMIN_ENFORCE_MFA = true` in
   `admin/lib/auth.ts`, rebuild (`npm run build`) and restart pm2:
   ```bash
   pm2 restart sensoria-admin
   ```
   From then on `requireAdmin()` redirects any session without a verified
   second factor (JWT `aal` claim ≠ `aal2`) to `/admin/login?mfa=1`.

> Note: sign-in itself still asks only for the password — supabase-js issues
> the aal2 session during `signInWithPassword` when the user's default factor
> is verified (challenge-and-verify happens transparently in the dashboard
> flow). If you later add a custom MFA challenge UI, call
> `supabase.auth.mfa.challenge()` / `mfa.verify()` between sign-in and the
> first dashboard request; `requireAdmin()` needs no changes either way.

**Rollback:** set the flag back to `false` — no DB or Supabase change needed.

---

## 2. Enforce a strong password policy (Supabase Auth)

Password rules live in Supabase Auth, **not** in this codebase — the dashboard
has no signup form, but admins change passwords via the Supabase reset flow.

Dashboard → **Authentication → Providers → Email**:

| Setting | Value |
|---|---|
| Minimum password length | **12** |
| Required characters | lower **and** upper case, digits, **symbols** |
| Leaked password protection | **Enabled** (HaveIBeenPwned check — Pro plan and above) |
| Require current password on change | **Enabled** (Authentication → Settings) |

The same policy is mirrored in code as `ADMIN_PASSWORD_POLICY`
(`admin/lib/auth.ts`) so server-side checks and docs agree. Supabase rejects
weak or leaked passwords at sign-up/change time with `AuthWeakPasswordError`;
the login action maps that to a dedicated message on
`/admin/login?error=weak_password` (existing users can still sign in with an
old weak password but are shown this warning to rotate).

Because there is no self-serve signup, set admin passwords when creating the
user (Authentication → Users → Add user) — use a password manager to generate
a 16+ character random passphrase.

---

## 3. Login rate limiting (shipped in code)

`admin/app/admin/login/actions.ts` rate limits **before** calling Supabase
Auth (`admin/lib/rate-limit.ts`):

- **Per email**: 5 failed attempts / 10 min → temporarily locked out.
- **Per IP**: same window — defeats one attacker spraying many addresses.
- **Global**: 30 failures / 10 min — defeats distributed guesses against the
  small allowlist.
- Allowlist pre-check: an email that is not in `admin_users` never reaches
  Supabase Auth, so probes of `admin@…` neither leak account existence nor
  burn auth-service quota.
- Every blocked, failed, and successful attempt lands in `admin_audit_log`
  (`login_rate_limited`, `login_failed`, `login_succeeded`).

The limiter is in-memory (single pm2 process; restart clears counters). If you
ever scale the dashboard to multiple instances, swap `recordFailure` /
`checkAllowed` for a Redis-backed limiter — the interface stays the same.
For defense in depth you can additionally set a per-IP limit on the aaPanel
reverse proxy / fail2ban in front of port 3100.

---

## 4. Audit log (shipped in code)

- Table: `public.admin_audit_log` — created by
  `supabase/migrations/20260913_admin_audit_log.sql`. Append-only: RLS gives
  admins SELECT only, and **no UPDATE/DELETE policies exist**, so no JWT can
  rewrite history. INSERTs go through the service role from server actions.
- Helper: `writeAudit()` in `admin/lib/audit.ts` — fire-and-forget; an audit
  failure never breaks the user-facing action (logged to pm2 stderr instead).
  Keys matching /password|secret|token|key|nonce/i are stripped from metadata.
- Reviewed at **`/admin/audit`** — filter by action or actor, click a row for
  the full metadata drawer.
- Retention: 365 days, pruned nightly by `pg_cron` job
  `trim-admin-audit-log` (verify: `SELECT * FROM cron.job WHERE jobname =
  'trim-admin-audit-log';`). Widen the interval in `trim_admin_audit_log()`
  if compliance requires longer retention.

**Covered actions:** transaction override & settlement retry, subscription
extend & revoke, plan upsert & toggle, settings update, all three login
outcomes, and every admin-team change (invite, role change, removal —
Owner-only, see `20260913_admin_roles.sql`).

---

## 5. First-run checklist (new deployment)

```text
[ ] Run supabase/migrations/20260913_admin_audit_log.sql in the SQL editor
[ ] Run supabase/migrations/20260913_admin_roles.sql (promotes the first allowlisted email to Owner)
[ ] Run supabase/migrations/20260913_telegram_paid_notifications.sql (paid-transaction pings; needs bot token + chat id via ALTER DATABASE — see file header)
[ ] Run supabase/migrations/20260913_telegram_alerts_digest.sql (stale-pending alert + Monday digest)
[ ] Run supabase/migrations/20260913_location_retention.sql (30-day child-location purge)
[ ] Run supabase/migrations/20260913_manual_refunds.sql (refunds ledger + claw-back RPC) [ ] Run supabase/migrations/20260913_royalty_payments.sql (monthly royalty settlement)
 [ ] Run supabase/migrations/20260913_parent_contacts.sql (parent contact registry + sync triggers)
 [ ] Run supabase/migrations/20260913_parent_slot_packs.sql (plans.kind + apply_parent_slot_purchase RPC + Rp 25.000 slot-pack seed)
 [ ] Run supabase/migrations/20260913_parent_slot_enforcement.sql (DB-level max_parent_slots enforcement on family_links)
 [ ] Run supabase/migrations/20260913_refund_slot_aware.sql (refund RPC v2 — slot-aware claw-back)
[ ] Authentication → Providers → Email: 12-char min + character classes + leaked-password protection
[ ] Authentication → Multi-Factor Auth: enable App Authenticator (TOTP)
[ ] Create the Owner auth user, allowlist in admin_users; invite further admins from /admin/team (Support role)
[ ] Each admin enrolls TOTP from /admin
[ ] Set ADMIN_ENFORCE_MFA = true in admin/lib/auth.ts, rebuild, pm2 restart
[ ] Confirm cron.job has 'trim-admin-audit-log', 'expire-stale-subscriptions', 'prune-old-locations', 'alert-stale-pending-transactions', and 'weekly-digest'
[ ] Do one failing login + one successful login; verify both rows in /admin/audit
```
