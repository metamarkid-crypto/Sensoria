/**
 * Sensoria AAC — True Background Location (Roadmap Item #3)
 *
 * The Child node's background tracker. Runs under expo-task-manager so the
 * device keeps reporting position while the app is backgrounded or (on
 * Android, with a foreground service) even after the UI is swiped away.
 *
 * Entitlement rule (Compassionate Child protocol):
 *   • phase 'premium' | 'grace'  → tracking keeps running.
 *   • phase 'locked'             → the task IMMEDIATELY stops itself to save
 *                                  battery and respect the paywall.
 *   • phase 'unknown' (fresh boot before AsyncStorage rehydrates) → allowed;
 *     the very next task invocation re-checks and self-corrects once the
 *     persisted boundaries are restored.
 *
 * Throttling: OS-level `timeInterval` (3 min) + a writer-side timestamp guard
 * so the database is never hammered. Every accepted write appends to the
 * `locations` history table AND refreshes the live `devices` presence columns
 * (keeps the existing ParentDashboard `devices` realtime channel alive).
 */
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { supabase } from '../db/supabase';
import { useAACStore } from '../../store/useAACStore';
import { evaluateAccess } from '../db/entitlement';

export const BACKGROUND_LOCATION_TASK = 'sensoria-background-location';

/** Minimum wall-clock time between database writes (3 minutes). */
export const WRITE_INTERVAL_MS = 3 * 60 * 1000;

/** OS minimum time between location updates (Android best-effort). */
const OS_UPDATE_INTERVAL_MS = 3 * 60 * 1000;

/** Also update when the child moves ≥ this many meters. */
const DISTANCE_INTERVAL_M = 50;

// Module-scoped write stamp — survives across task invocations while the JS
// runtime lives. If the OS restarts the runtime between events, the OS-level
// timeInterval still throttles. (Last-write timestamps in AsyncStorage would
// add an unnecessary I/O dependency for the same guarantee.)
let lastWriteAt = 0;

const hasLiveTracking = async (): Promise<boolean> =>
  Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);

/**
 * Reverse-geocode + persist one snapshot. `force` bypasses the throttle for
 * explicit refreshes (parent ping, foreground setup) — never background spam.
 */
export const writeLocationSnapshot = async (
  loc: Location.LocationObject,
  force = false,
): Promise<void> => {
  const now = Date.now();
  if (!force && now - lastWriteAt < WRITE_INTERVAL_MS) return;
  lastWriteAt = now;

  const { deviceId } = useAACStore.getState();
  if (!deviceId) return;

  const { latitude, longitude, accuracy } = loc.coords;

  let address: string | null = null;
  try {
    const geocode = await Location.reverseGeocodeAsync({ latitude, longitude });
    if (geocode && geocode.length > 0) {
      address = `${geocode[0].street || geocode[0].name || ''}, ${geocode[0].city || geocode[0].region || ''}`.trim();
    }
  } catch {
    // Reverse geocoding is best-effort; never fail a GPS write because of it.
  }

  // History row — the Parent map subscribes to INSERTs on this table.
  const { error: histError } = await supabase.from('locations').insert({
    child_device_id: deviceId,
    latitude,
    longitude,
    accuracy: typeof accuracy === 'number' ? accuracy : null,
    address,
  });
  if (histError) {
    console.warn('[BackgroundLocation] locations insert failed:', histError.message);
  }

  // Live presence — keeps ParentDashboard's `devices` realtime channel fresh.
  const { error: presenceError } = await supabase
    .from('devices')
    .update({
      latitude,
      longitude,
      last_address: address,
      last_seen: new Date().toISOString(),
    })
    .eq('id', deviceId);
  if (presenceError) {
    console.warn('[BackgroundLocation] devices presence update failed:', presenceError.message);
  }
};

/** Grab a fresh GPS fix NOW and write it (used by the parent refresh ping). */
export const requestImmediateLocation = async (): Promise<void> => {
  const loc = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.Balanced,
  });
  await writeLocationSnapshot(loc, true);
};

/**
 * Start (idempotent) the background tracker. Requests foreground permission
 * first, then background permission on Android; if background is denied the
 * tracker simply never runs and the one-shot foreground updates still work.
 */
export const ensureBackgroundTracking = async (): Promise<void> => {
  if (await hasLiveTracking()) return;

  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return;

  if (TaskManager.isTaskDefined(BACKGROUND_LOCATION_TASK)) {
    await Location.requestBackgroundPermissionsAsync().catch(() => null);
  }

  await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: OS_UPDATE_INTERVAL_MS,
    distanceInterval: DISTANCE_INTERVAL_M,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Sensoria melacak lokasi',
      notificationBody:
        'Lokasi anak dikirim agar orang tua tetap dapat memantau keberadaannya.',
      notificationColor: '#11427B',
      killServiceOnDestroy: false,
    },
  });
};

/** Stop the tracker — used the moment the Child's phase flips to 'locked'. */
export const stopBackgroundTracking = async (): Promise<void> => {
  if (!(await hasLiveTracking())) return;
  await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => null);
};

// Task registration — module scope so it exists in the bundle even when the
// OS cold-starts the JS runtime for a background event.
TaskManager.defineTask(
  BACKGROUND_LOCATION_TASK,
  async ({ data, error }: { data?: { locations?: Location.LocationObject[] }; error?: any }) => {
    if (error) {
      console.warn('[BackgroundLocation] task error:', error);
      return;
    }

    // Entitlement check runs INSIDE the task: a locked Child stops itself.
    const { premium, role } = useAACStore.getState();
    const access = evaluateAccess(premium, role === 'Child' ? 'Child' : 'None', Date.now());
    if (access.phase === 'locked') {
      console.info('[BackgroundLocation] entitlement locked — stopping background task');
      await stopBackgroundTracking();
      return;
    }

    const locations = data?.locations ?? [];
    for (const loc of locations) {
      await writeLocationSnapshot(loc);
    }
  },
);