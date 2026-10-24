import { useCallback, useEffect, useRef } from 'react';
import { supabase } from '../services/db/supabase';
import { queueCloudOp } from '../services/db/sqlite';
import { publishSettingsPatch } from '../services/settings/settingsSync';
import {
  resolveChildDeviceId,
  useAACStore,
  type SyncedSettingsPatch,
} from '../store/useAACStore';

/**
 * Debounce for the settings write path. Sliders (card spacing, speech rate,
 * volume, hold duration) fire on every drag tick — writing per tick would
 * hammer Supabase and, worse, broadcast a storm of intermediate values to the
 * child device. 600ms is short enough to feel instant and long enough to
 * collapse a drag into one write.
 */
export const SETTINGS_SYNC_DEBOUNCE_MS = 600;

/**
 * useSettingsSync — the ONE write path for mirrored settings.
 *
 * Every settings screen (Voice / Appearance / Accessibility, in BOTH modes)
 * funnels through this hook instead of hand-rolling its own
 * `syncToDatabase` + outbox copy (there used to be three near-identical
 * copies, which is why "Balasan Visual" could drift while the others worked).
 *
 * One call does three things:
 *   1. LOCAL MIRROR — merge the patch into `childProfile.settings` so the next
 *      edit merges over fresh values (screens use that blob as their base).
 *   2. PEER PUSH — broadcast the patch to the other device immediately; this
 *      is what makes parent ⇄ child sync work on the current database, where
 *      `child_profiles` is not in the realtime publication.
 *   3. CLOUD WRITE — the authoritative row, with the existing offline outbox
 *      fallback (`child_profiles.settings` replays as a remote MERGE, so a
 *      replayed edit never clobbers newer fields written by the peer).
 */
export function useSettingsSync() {
  const role = useAACStore((s) => s.role);
  const deviceId = useAACStore((s) => s.deviceId);
  const childProfile = useAACStore((s) => s.childProfile);

  const targetDeviceId = resolveChildDeviceId(childProfile, deviceId, role) ?? null;
  const targetRef = useRef<string | null>(targetDeviceId);
  useEffect(() => {
    targetRef.current = targetDeviceId;
  }, [targetDeviceId]);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<SyncedSettingsPatch>({});

  const flush = useCallback(async () => {
    const childId = targetRef.current;
    const patch = pendingRef.current;
    pendingRef.current = {};
    if (!childId || Object.keys(patch).length === 0) return;

    // Peer first: the other mode should react even if the DB write is slow
    // or the device is offline (broadcast is fire-and-forget).
    void publishSettingsPatch(childId, patch);

    const profile = useAACStore.getState().childProfile;
    const merged = { ...(profile?.settings || {}), ...patch };
    try {
      const { error } = await supabase
        .from('child_profiles')
        .update({ settings: merged })
        .eq('device_id', childId);
      if (error) throw error;
    } catch {
      // Offline / RLS blip — park ONLY this patch; the flusher re-merges it
      // over the remote blob so it can never overwrite the peer's newer keys.
      await queueCloudOp('child_profiles.settings', {
        device_id: childId,
        settings: patch,
      });
    }
  }, []);

  const syncSettings = useCallback((patch: SyncedSettingsPatch) => {
    // Mirror locally right away (the screens already called their setter, so
    // a diff-based apply would skip the childProfile merge).
    useAACStore.setState((state) => ({
      childProfile: state.childProfile
        ? {
            ...state.childProfile,
            settings: { ...(state.childProfile.settings || {}), ...patch },
          }
        : state.childProfile,
    }));

    pendingRef.current = { ...pendingRef.current, ...patch };
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void flush();
    }, SETTINGS_SYNC_DEBOUNCE_MS);
  }, [flush]);

  // Leaving the screen mid-drag must still commit the pending patch.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (Object.keys(pendingRef.current).length > 0) void flush();
  }, [flush]);

  return { syncSettings, targetDeviceId };
}
