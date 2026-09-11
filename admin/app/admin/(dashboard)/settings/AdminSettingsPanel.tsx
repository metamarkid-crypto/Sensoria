"use client";

import { useState, useTransition } from "react";
import { ShieldAlert, Megaphone, Wrench, Hourglass } from "lucide-react";
import clsx from "clsx";
import type { AppSettingsRow } from "@/lib/types";
import { Card } from "@/components/ui";
import { updateSettingsAction, type SettingsPatch } from "./actions";

function Toggle({
  on,
  onChange,
  disabled,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={clsx(
        "relative h-6 w-11 shrink-0 rounded-full transition",
        on ? "bg-teal" : "bg-slate-600",
        disabled && "opacity-50",
      )}
    >
      <span
        className={clsx(
          "absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all",
          on ? "left-[22px]" : "left-0.5",
        )}
      />
    </button>
  );
}

export default function AdminSettingsPanel({
  settings,
}: {
  settings: AppSettingsRow;
}) {
  const [announcement, setAnnouncement] = useState(
    settings.announcement_text ?? "",
  );
  const [trialDays, setTrialDays] = useState(String(settings.trial_duration_days));
  const [graceDays, setGraceDays] = useState(String(settings.child_grace_period_days));
  const [toast, setToast] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const push = (patch: SettingsPatch) => {
    startTransition(async () => {
      const res = await updateSettingsAction(patch);
      setToast(res.message);
      setTimeout(() => setToast(null), 4000);
    });
  };

  const saveNumbers = () => {
    push({
      trial_duration_days: Number(trialDays),
      child_grace_period_days: Number(graceDays),
    });
  };

  return (
    <div className="space-y-6">
      {/* ── Stealth kill-switch ─────────────────────────────────────────── */}
      <Card title="Stealth mode — App Review kill-switch">
        <div className="flex items-start justify-between gap-6">
          <div className="max-w-xl">
            <p className="flex items-center gap-2 text-sm font-semibold text-slate-200">
              <ShieldAlert size={15} className={settings.web_payment_active ? "text-emerald-300" : "text-amber-300"} />
              web_payment_active = {String(settings.web_payment_active)}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              OFF: paywall hidden and upgrade banners suppressed on every live
              app — the App Review posture. ON: QRIS paywall and upgrade
              banners go live. Locked parents always keep their hard lock;
              only the payment view is switched.
            </p>
          </div>
          <Toggle
            on={settings.web_payment_active}
            disabled={pending}
            onChange={(next) => push({ web_payment_active: next })}
          />
        </div>
      </Card>

      {/* ── Maintenance mode ────────────────────────────────────────────── */}
      <Card title="Maintenance mode">
        <div className="flex items-start justify-between gap-6">
          <div className="max-w-xl">
            <p className="flex items-center gap-2 text-sm font-semibold text-slate-200">
              <Wrench size={15} className={settings.maintenance_mode ? "text-rose-300" : "text-slate-400"} />
              maintenance_mode = {String(settings.maintenance_mode)}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              Global flag for the mobile clients and landing page. Currently
              advisory — screens that read app_settings may show a maintenance
              notice; enforcement grows as clients adopt it.
            </p>
          </div>
          <Toggle
            on={settings.maintenance_mode}
            disabled={pending}
            onChange={(next) => push({ maintenance_mode: next })}
          />
        </div>
      </Card>

      {/* ── Announcement banner ─────────────────────────────────────────── */}
      <Card title="System announcement">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-slate-200">
              <Megaphone size={15} className={settings.announcement_active ? "text-teal" : "text-slate-500"} />
              broadcast to all apps
            </p>
            <Toggle
              on={settings.announcement_active}
              disabled={pending}
              onChange={(next) => push({ announcement_active: next })}
            />
          </div>
          <textarea
            rows={3}
            value={announcement}
            onChange={(e) => setAnnouncement(e.target.value)}
            placeholder="e.g. Server maintenance Sun 02:00–03:00 WIB. Terima kasih atas pengertiannya!"
            className="glass-input resize-none"
          />
          <button
            type="button"
            disabled={pending}
            onClick={() => push({ announcement_text: announcement })}
            className="btn-teal"
          >
            Save announcement text
          </button>
          <p className="text-xs text-slate-500">
            Saving text does not activate the banner — use the toggle to
            broadcast (id-ID copy recommended; users are Indonesian parents).
          </p>
        </div>
      </Card>

      {/* ── Trial & grace ───────────────────────────────────────────────── */}
      <Card title="Trial & grace windows">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
              <Hourglass size={13} /> Free trial duration (days)
            </label>
            <input
              inputMode="numeric"
              value={trialDays}
              onChange={(e) => setTrialDays(e.target.value)}
              className="glass-input"
            />
            <p className="mt-1 text-xs text-slate-500">
              Applied to NEW trial injections at child setup.
            </p>
          </div>
          <div>
            <label className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
              <Hourglass size={13} /> Child grace period (days)
            </label>
            <input
              inputMode="numeric"
              value={graceDays}
              onChange={(e) => setGraceDays(e.target.value)}
              className="glass-input"
            />
            <p className="mt-1 text-xs text-slate-500">
              Compassionate window after expiry. Parents always get zero.
            </p>
          </div>
        </div>
        <button type="button" onClick={saveNumbers} disabled={pending} className="btn-teal mt-4">
          Save windows
        </button>
      </Card>

      {toast ? (
        <div className="fixed bottom-6 right-6 z-50 rounded-xl border border-teal/40 bg-ink-card px-4 py-3 text-sm text-slate-100 shadow-glass">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
