import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { resolveChildDeviceId, useAACStore } from '../store/useAACStore';
import {
  fetchRemoteSettings,
  subscribeSettingsSync,
} from '../services/settings/settingsSync';
import { flushCloudOps } from '../services/db/supabase';

/**
 * SettingsSyncBridge — one app-level mirror for the Parent ⇄ Child settings.
 *
 * Mounted ONCE in App.tsx (outside the navigator) because the mirror is not a
 * screen concern: whichever mode is active, the device must (a) receive the
 * peer's patches instantly and (b) repair missed ones when it comes back to
 * the foreground. Putting it in a screen would break the mirror the moment
 * the child navigates into Settings — the exact place they are edited.
 *
 * Responsibilities
 *   • subscribe to the broadcast mesh for the resolved child device id;
 *   • apply incoming patches through the whitelisted store action
 *     (`applySettingsPatch`) — never raw `setState`, so a foreign key can
 *     never leak into unrelated store state;
 *   • REST catch-up on mount and on every foreground resume, covering
 *     changes made while this device was offline / socket-down.
 *
 * Both directions use the SAME child id (a Parent writes its linked child's
 * row; a Child writes its own), so parent → child and child → parent are
 * symmetric by construction.
 */
export default function SettingsSyncBridge() {
  const role = useAACStore((s) => s.role);
  const deviceId = useAACStore((s) => s.deviceId);
  const childProfile = useAACStore((s) => s.childProfile);

  const childDeviceId = resolveChildDeviceId(childProfile, deviceId, role) ?? null;

  // Latest id in a ref so the foreground listener never uses a stale target
  // after an unlink/relink mid-session.
  const childDeviceIdRef = useRef<string | null>(childDeviceId);
  useEffect(() => {
    childDeviceIdRef.current = childDeviceId;
  }, [childDeviceId]);

  // 1. Instant path — peer patches over broadcast.
  useEffect(() => {
    if (!childDeviceId || role === 'None') return;
    return subscribeSettingsSync(childDeviceId, (patch) => {
      useAACStore.getState().applySettingsPatch(patch);
    });
  }, [childDeviceId, role]);

  // 2. Repair path — authoritative catch-up on mount + every resume.
  useEffect(() => {
    if (!childDeviceId || role === 'None') return;
    let cancelled = false;

    const catchUp = async () => {
      const target = childDeviceIdRef.current;
      if (!target) return;
      // Order matters: drain the outbox FIRST so an edit this device made
      // offline is in the cloud before we read it back. Otherwise the catch-up
      // would apply the stale remote value over a not-yet-flushed local change.
      await flushCloudOps();
      const patch = await fetchRemoteSettings(target);
      if (cancelled || !patch) return;
      useAACStore.getState().applySettingsPatch(patch);
    };

    void catchUp();

    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void catchUp();
    });

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [childDeviceId, role]);

  return null;
}
