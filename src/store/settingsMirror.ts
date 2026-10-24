/**
 * settingsMirror — the pure half of the Parent ⇄ Child settings mirror.
 *
 * Deliberately dependency-free (no store, no Supabase, no React Native): this
 * is the validation gate that every settings payload must pass — locally typed
 * by a screen, broadcast from the peer device, replayed from the offline
 * outbox, or read back from `child_profiles.settings`. Keeping it pure means
 * the rules can be executed/tested in plain Node, and the store stays the only
 * place that owns state.
 *
 * Rules
 *   • Only the mirrored keys below survive; anything else is dropped, so a
 *     stale/foreign blob can never leak into unrelated store state.
 *   • Enums (`cardSize`, `textSize`) accept only their documented values.
 *   • Ranges (`cardSpacing`, `speechRate`, `volume`, `holdDuration`) are
 *     clamped to the same bounds the sliders expose — a corrupt payload can
 *     never put speech rate at 50× or volume at 12.
 *   • Booleans must actually be booleans (a string "true" is rejected);
 *     `selectedVoice` must be a non-empty string.
 *   • null/undefined mean "not provided" and are ignored, never written.
 */

export const SYNCED_SETTING_KEYS = [
  'cardSize',
  'textSize',
  'cardSpacing',
  'enableCategoryColors',
  'highContrast',
  'visualRepliesEnabled',
  'notificationsEnabled',
  'speechRate',
  'volume',
  'selectedVoice',
  'speakOnTap',
  'soundFeedback',
  'holdDuration',
  'ignoreRepeat',
  'releaseToSpeak',
] as const;

export type SyncedSettingKey = (typeof SYNCED_SETTING_KEYS)[number];
export type SettingValue = string | number | boolean;
export type SettingsRecord = Partial<Record<SyncedSettingKey, SettingValue>>;

const ENUM_VALUES: Partial<Record<SyncedSettingKey, readonly string[]>> = {
  cardSize: ['S', 'M', 'L', 'XL'],
  textSize: ['A-', 'A', 'A+'],
};

const NUMBER_RANGES: Partial<Record<SyncedSettingKey, readonly [number, number]>> = {
  cardSpacing: [0, 40],
  speechRate: [0.5, 2],
  volume: [0, 1],
  holdDuration: [0, 2],
};

const BOOLEAN_KEYS: readonly SyncedSettingKey[] = [
  'enableCategoryColors',
  'highContrast',
  'visualRepliesEnabled',
  'notificationsEnabled',
  'speakOnTap',
  'soundFeedback',
  'ignoreRepeat',
  'releaseToSpeak',
];

const STRING_KEYS: readonly SyncedSettingKey[] = ['selectedVoice'];

/** Coerce one raw value against the rules for `key`; undefined = reject. */
function coerce(key: SyncedSettingKey, value: unknown): SettingValue | undefined {
  if (value === undefined || value === null) return undefined;

  const allowed = ENUM_VALUES[key];
  if (allowed) {
    return typeof value === 'string' && allowed.includes(value) ? value : undefined;
  }

  const range = NUMBER_RANGES[key];
  if (range) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    if (value < range[0] || value > range[1]) return undefined;
    return value;
  }

  if (BOOLEAN_KEYS.includes(key)) {
    return typeof value === 'boolean' ? value : undefined;
  }

  if (STRING_KEYS.includes(key)) {
    return typeof value === 'string' && value.length > 0 && value.length <= 64
      ? value
      : undefined;
  }

  return undefined;
}

/**
 * Validate an untrusted settings payload into the mirrored subset.
 * Unknown keys, wrong types and out-of-range values are silently dropped —
 * never coerced — so a partially corrupt blob still applies its valid fields.
 */
export function sanitizeSettingsPatch(raw: unknown): SettingsRecord {
  const clean: SettingsRecord = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return clean;

  const source = raw as Record<string, unknown>;
  for (const key of SYNCED_SETTING_KEYS) {
    const value = coerce(key, source[key]);
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

/**
 * Keep only the keys whose value actually differs from `current` — the diff
 * that decides whether a state write (and a re-render) is needed at all.
 */
export function diffSettingsPatch(
  current: Record<string, unknown>,
  patch: SettingsRecord,
): SettingsRecord {
  const changed: SettingsRecord = {};
  for (const key of SYNCED_SETTING_KEYS) {
    if (!(key in patch)) continue;
    if (patch[key] === current[key]) continue;
    changed[key] = patch[key];
  }
  return changed;
}
