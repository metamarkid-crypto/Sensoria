import { supabase } from './supabase';
import { AppState } from 'react-native';
import type { RealtimeChannel } from '@supabase/supabase-js';

/**
 * Realtime entitlement watcher — remote truth without waiting for a resume.
 *
 * Listens for postgres_changes on the ENTITLEMENT INPUT tables:
 *  • `subscriptions` — a remote RENEWAL (apply_plan_purchase writes new
 *    status/dates), CANCELLATION, or the hourly cron's expiry flip lands on a
 *    LIVE parent session in under a second instead of at the next foreground
 *    resume (previously the only remote-truth trigger in-session).
 *  • `family_links` — pairing/unpairing changes WHICH child's row the Combo
 *    rule evaluates, so the resolved entitlement must be re-read mid-session.
 *
 * NOT a parallel gate. Every event funnels into `refreshEntitlement()` — the
 * single authoritative derivation path (fetch → evaluateAccess → evaluateGate)
 * — so realtime can never disagree with the offline/watchdog/refresh logic.
 * Event payloads are deliberately never trusted to mutate boundaries directly.
 *
 * Server prerequisites (migration 20260911_enable_realtime_subscriptions.sql):
 * both tables must be in the `supabase_realtime` publication. Without that,
 * the channel simply never fires — foreground resume keeps working as the
 * fallback, so a missing publication degrades, never breaks.
 *
 * Client behavior:
 *  • Debounce (~800ms, trailing): bursts (cron flipping many rows, a purchase
 *    writing several fields) coalesce into ONE refresh.
 *  • Only a row actually belonging to this device's Combo triggers a refresh;
 *    foreign-child events are dropped (a parent never receives only-its-own
 *    events — there is no per-device key on the subscriptions table, so the
 *    channel is intentionally unfiltered).
 *  • DELETE carries only the old row's PRIMARY KEY (Replica Identity
 *    default) — `old.child_device_id` is enough for the relevance check, and
 *    the debounced refresh re-fetches the authoritative state anyway.
 *  • family_links payloads expose NO child/parent columns under the default
 *    Replica Identity, so they cannot be matched locally: every link event
 *    triggers a full refresh. Rare (pairing moments) → acceptable noise.
 *  • Offline events are missed (TCP dies), but AppState resume still runs
 *    refreshEntitlement() — the pending-drain below turns any events that DID
 *    queue while the JS timer was suspended into an immediate refresh.
 *
 * Returns a cleanup function; safe to call multiple times.
 */
export const ENTITLEMENT_REALTIME_DEBOUNCE_MS = 800;

export const subscribeEntitlementRealtime = (
  opts: {
    /** Current Combo children — events outside this set are ignored. */
    getRelevantChildIds: () => string[];
    /** The authoritative re-read (store's refreshEntitlement). */
    refresh: () => Promise<void>;
  },
): (() => void) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let linked = false;

  const scheduleRefresh = (relevant: boolean) => {
    pending = pending || relevant;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!pending) return;
      pending = false;
      void opts.refresh();
    }, ENTITLEMENT_REALTIME_DEBOUNCE_MS);
  };

  const isRelevant = (childId: unknown) =>
    typeof childId === 'string' && opts.getRelevantChildIds().includes(childId);

  const channel: RealtimeChannel = supabase
    .channel('entitlement-watcher')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'subscriptions' },
      (payload) => {
        // UPDATE/INSERT: `new` carries the full row. DELETE: only the PK
        // (plus unique columns) survives in `old` — still enough to judge
        // relevance and re-fetch.
        const childId =
          (payload.new as { child_device_id?: unknown } | null)?.child_device_id ??
          (payload.old as { child_device_id?: unknown } | null)?.child_device_id;
        scheduleRefresh(isRelevant(childId));
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'family_links' },
      () => {
        // No usable filter columns under the default Replica Identity →
        // always refresh; the debouncer keeps the cost to one round-trip.
        scheduleRefresh(true);
      },
    )
    .subscribe((status) => {
      linked = status === 'SUBSCRIBED';
    });

  // Resume while suspended: JS timers were frozen and the queued callback may
  // not have run at all. If any relevant change was pending, drain it into an
  // IMMEDIATE refresh (the AppState refresh in App.tsx would have covered it
  // anyway — this just removes the delay). The channel also self-heals:
  // supabase-js re-subscribes after a socket drop.
  const onAppState = (state: string) => {
    if (state !== 'active') return;
    if (pending && timer) {
      clearTimeout(timer);
      timer = null;
      pending = false;
      void opts.refresh();
    }
    if (!linked) channel.subscribe();
  };
  const appStateSub = AppState.addEventListener('change', onAppState);

  return () => {
    appStateSub.remove();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = false;
    void supabase.removeChannel(channel);
  };
};
