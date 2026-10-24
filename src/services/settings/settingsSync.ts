/**
 * settingsSync — Parent ⇄ Child settings mirror.
 *
 * WHY this module exists
 * ----------------------
 * `child_profiles.settings` is a single JSON blob that BOTH modes write
 * (appearance, visual replies, voice, accessibility). Before this module the
 * only refresh paths were "fetch once when the Child screen mounts" and a
 * `postgres_changes` listener on `child_profiles` — and that table is NOT in
 * the `supabase_realtime` publication, so those UPDATE events never arrive.
 * Result: a Parent toggled "Balasan Visual" and the Child device kept the old
 * behaviour until the app was force-closed and reopened.
 *
 * Transport (three layers, each independent):
 *   1. BROADCAST MESH (primary, instant) — a Realtime *broadcast* channel
 *      per child device (`sensoria-settings-<childId>`). Broadcast does not
 *      depend on the table being in the publication, so it works on today's
 *      production database with no migration. Messages carry the originating
 *      device tag so the sender never re-applies its own echo.
 *   2. REST CATCH-UP (repair, offline-tolerant) — on mount / foreground resume
 *      the peer re-reads the authoritative row, covering toggles that happened
 *      while the other device was offline or the socket was down.
 *   3. POSTGRES CHANGES (optional fallback) — stays wired in the screens; once
 *      `supabase/migrations/20261024_child_profiles_realtime.sql` is applied
 *      it delivers the same patches DB-side.
 *
 * Every incoming payload is filtered through `sanitizeSettingsPatch` (the
 * single whitelist in `../store/settingsMirror`) and applied with
 * `applySettingsPatch`, which writes only values that actually changed and
 * never writes back to the cloud — so parent → child and child → parent
 * cannot loop.
 */
import { supabase, isSupabaseConfigured } from '../db/supabase';
import { sanitizeSettingsPatch, type SettingsRecord } from '../../store/settingsMirror';
import { useAACStore } from '../../store/useAACStore';

/** Broadcast event name — versioned so a future payload shape can coexist. */
export const SETTINGS_SYNC_EVENT = 'settings-update-v1';

export interface SettingsSyncMeta {
  /** `${role}:${deviceId}` of the device that published the patch. */
  origin: string;
  /** Publisher clock (ms) — informational only, never used for ordering. */
  at: number;
}

type PeerListener = (patch: SettingsRecord, meta: SettingsSyncMeta) => void;

interface ChannelEntry {
  channel: ReturnType<typeof supabase.channel>;
  listeners: Set<PeerListener>;
  /** Resolves once the socket has actually JOINED the topic. */
  joined: Promise<void>;
}

const entries = new Map<string, ChannelEntry>();

/** Identity of THIS device inside the mesh (never sent as a secret). */
const originTag = (): string => {
  const { role, deviceId } = useAACStore.getState();
  return `${role}:${deviceId ?? 'unpaired'}`;
};

const channelName = (childDeviceId: string) => `sensoria-settings-${childDeviceId}`;

function ensureEntry(childDeviceId: string): ChannelEntry {
  const existing = entries.get(childDeviceId);
  if (existing) return existing;

  let markJoined: () => void = () => {};
  const joined = new Promise<void>((resolve) => {
    markJoined = resolve;
  });

  const entry: ChannelEntry = {
    channel: supabase.channel(channelName(childDeviceId), {
      // self:false → the sender never receives its own patch; the origin tag
      // below is a second guard in case a transport re-delivers it anyway.
      config: { broadcast: { self: false } },
    }),
    listeners: new Set(),
    joined,
  };

  entry.channel
    .on('broadcast', { event: SETTINGS_SYNC_EVENT }, (message: any) => {
      const payload = message?.payload ?? {};
      const patch = sanitizeSettingsPatch(payload.patch);
      if (Object.keys(patch).length === 0) return;
      const meta: SettingsSyncMeta = {
        origin: typeof payload.origin === 'string' ? payload.origin : 'unknown',
        at: typeof payload.at === 'number' ? payload.at : 0,
      };
      if (meta.origin === originTag()) return; // our own echo — ignore
      for (const listener of Array.from(entry.listeners)) {
        try {
          listener(patch, meta);
        } catch {
          // A throwing listener must never break the mesh for the others.
        }
      }
    })
    .subscribe((status: string) => {
      if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        // CHANNEL_ERROR/CLOSED also resolve: `send` then reports the truth
        // instead of hanging forever waiting for a join that will not happen.
        markJoined();
      }
    });

  entries.set(childDeviceId, entry);
  return entry;
}

function disposeEntry(childDeviceId: string): void {
  const entry = entries.get(childDeviceId);
  if (!entry) return;
  entries.delete(childDeviceId);
  try {
    void supabase.removeChannel(entry.channel);
  } catch {
    // Channel already gone — nothing to clean up.
  }
}

/**
 * Listen for settings published by the peer device. Returns an unsubscribe
 * function; when the last listener leaves, the channel is torn down so a
 * role switch (or unlink/relink) re-targets cleanly instead of leaking.
 */
export function subscribeSettingsSync(
  childDeviceId: string | null,
  listener: PeerListener,
): () => void {
  if (!childDeviceId || !isSupabaseConfigured) return () => {};

  const entry = ensureEntry(childDeviceId);
  entry.listeners.add(listener);

  return () => {
    const current = entries.get(childDeviceId);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) disposeEntry(childDeviceId);
  };
}

/**
 * Publish a settings patch to the peer device (instant path, fire-and-forget).
 * Returns true when the broadcast was acknowledged by the socket.
 */
export async function publishSettingsPatch(
  childDeviceId: string | null,
  patch: SettingsRecord,
): Promise<boolean> {
  if (!childDeviceId || !isSupabaseConfigured) return false;
  const clean = sanitizeSettingsPatch(patch);
  if (Object.keys(clean).length === 0) return false;

  try {
    const entry = ensureEntry(childDeviceId);
    const send = () => entry.channel.send({
      type: 'broadcast',
      event: SETTINGS_SYNC_EVENT,
      payload: { patch: clean, origin: originTag(), at: Date.now() },
    });

    // A brand-new channel is still JOINING: `send` before the join answers
    // 'timed out' and the message is lost. Wait (bounded) for the join, then
    // send; if the first attempt still fails, retry once after a short beat.
    await Promise.race([entry.joined, new Promise((resolve) => setTimeout(resolve, 1500))]);
    let response = await send();
    if (response !== 'ok') {
      await new Promise((resolve) => setTimeout(resolve, 300));
      response = await send();
    }
    // supabase-js answers 'ok' | 'timed out' | 'error' — only 'ok' is proof.
    return response === 'ok';
  } catch {
    // Offline / socket closed: the REST catch-up on the peer's next resume
    // repairs it. Never surface this as a user-facing failure.
    return false;
  }
}

/**
 * Authoritative catch-up: read `child_profiles.settings` for the given child
 * and return the whitelisted subset (null when unreachable). Callers apply it
 * with `applySettingsPatch`, so only changed keys cause a re-render.
 */
export async function fetchRemoteSettings(
  childDeviceId: string | null,
): Promise<SettingsRecord | null> {
  if (!childDeviceId || !isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase
      .from('child_profiles')
      .select('settings')
      .eq('device_id', childDeviceId)
      .maybeSingle();
    if (error || !data?.settings) return null;
    return sanitizeSettingsPatch(data.settings);
  } catch {
    return null;
  }
}
