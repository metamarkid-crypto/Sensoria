/**
 * childProfileHelpers — Single Source of Truth (SSOT) for ChildProfile & Gender normalization.
 *
 * Eliminates inconsistent gender reads across PairingBottomSheet, RoleSelectionScreen,
 * UserProfileScreen, ParentHomeScreen, ChildAACScreen, and OnboardingScreen.
 */
import type { ChildProfile } from '../store/useAACStore';

/**
 * Normalize any raw gender representation ('Boy', 'boy', 'Girl', 'girl', etc.)
 * from `childProfile.gender` or legacy JSONB `settings.childProfileGender` /
 * `settings.childVoiceGender` into canonical `'Boy' | 'Girl'`.
 */
export function normalizeChildGender(
  rawGender?: unknown,
  settings?: Record<string, any> | null,
  fallback: 'Boy' | 'Girl' = 'Boy',
): 'Boy' | 'Girl' {
  const candidate =
    rawGender ??
    settings?.childProfileGender ??
    settings?.childVoiceGender;

  if (typeof candidate === 'string') {
    const lower = candidate.trim().toLowerCase();
    if (lower === 'girl' || lower === 'female' || lower === 'perempuan') return 'Girl';
    if (lower === 'boy' || lower === 'male' || lower === 'laki-laki') return 'Boy';
  }
  return fallback;
}

/**
 * Build a clean, canonical ChildProfile object from a raw Supabase `child_profiles` row
 * merged over an optional existing local profile. Ensures `fullName`, `full_name`,
 * `nickname`, `device_id`, `gender`, and `settings.childProfileGender` are always consistent.
 */
export function buildChildProfileFromRow(
  row: {
    device_id?: string | null;
    full_name?: string | null;
    fullName?: string | null;
    nickname?: string | null;
    gender?: unknown;
    settings?: Record<string, any> | null;
  },
  existing?: ChildProfile,
  explicitDeviceId?: string | null,
): NonNullable<ChildProfile> {
  const mergedSettings = {
    ...(existing?.settings ?? {}),
    ...(row.settings ?? {}),
  };
  const gender = normalizeChildGender(
    row.gender,
    mergedSettings,
    existing?.gender ?? 'Boy',
  );
  mergedSettings.childProfileGender = gender;

  const fullName =
    row.full_name ??
    row.fullName ??
    existing?.fullName ??
    existing?.full_name ??
    '';
  const nickname = row.nickname ?? existing?.nickname ?? '';
  const deviceId =
    explicitDeviceId ?? row.device_id ?? existing?.device_id ?? undefined;

  return {
    ...existing,
    device_id: deviceId,
    full_name: fullName,
    fullName: fullName,
    nickname,
    gender,
    settings: mergedSettings,
  };
}

/**
 * Resolve display full name of a child profile with fallback.
 */
export function getChildDisplayName(
  profile: ChildProfile,
  fallback: string,
): string {
  return (
    profile?.fullName ||
    profile?.full_name ||
    profile?.nickname ||
    fallback
  );
}
