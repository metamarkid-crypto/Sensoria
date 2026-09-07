import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DEFAULT_CHILD_GRACE_DAYS,
  evaluateAccess,
  fetchPremiumEntitlement,
} from '../services/db/entitlement';
import { fetchPaywallSettings } from '../services/db/paywall';
import type { SubscriptionStatus } from '../services/db/types';
import type { EntitlementRole } from '../services/db/entitlement';

export type UserRole = 'None' | 'Child' | 'Parent';
export type AppLanguage = 'id' | 'en' | 'zh';
export type ChildProfile = { 
  device_id?: string;
  fullName?: string; 
  full_name?: string;
  nickname: string; 
  gender?: 'Boy' | 'Girl';
  settings?: any;
} | null;

export interface AACWord {
  id: string;
  word_id: string; // Indonesian
  word_en?: string; // English (optional — legacy rows / trilingual fill)
  word_zh: string; // Mandarin
  imageUrl?: string;
  categoryId: string;
  /**
   * Non-destructive favorite flag (SQLite `is_favorite`). Purely additive:
   * favoriting NEVER touches categoryId, so the card stays in its original
   * tab and the child's motor memory is preserved.
   */
  isFavorite?: boolean;
  isCustom?: boolean;
}

export interface AboutContent {
  description: string;
  contactEmail: string;
  version: string;
  privacyPolicyUrl: string;
}

/**
 * Global premium entitlement (Master Blueprint — Combo rule).
 *
 * Protocol — "Compassionate Child, Strict Parent". The raw expiry boundaries
 * (`status`, `trialEndsAt`, `expiresAt`) plus the dynamic grace length
 * (`childGracePeriodDays`) ARE persisted locally (offline-first mandate): a
 * Child launching offline must still know how long its grace window lasts.
 *
 * Derived booleans (`isPremium`, `loaded`, `lastError`) are NEVER persisted —
 * a stored "premium: true" would go stale while the app is offline. Instead
 * they are recomputed from the raw boundaries against `Date.now()` on every
 * refresh, on rehydration, and by any gate via `evaluateAccess()`. Time can
 * never be fooled by a stale flag.
 */
export interface PremiumState {
  /** Strict entitlement now (active/trial with a future end date). */
  isPremium: boolean;
  /** True once data is known: a fetch resolved, or raw state was rehydrated. */
  loaded: boolean;
  status: SubscriptionStatus | null;
  planId: string | null;
  trialEndsAt: string | null;
  expiresAt: string | null;
  /**
   * Dynamic child grace (days) cached from app_settings — persisted so the
   * Child node can compute its compassionate window entirely offline.
   */
  childGracePeriodDays: number;
  lastCheckedAt: number | null;
  /** Set when a refresh errors — kept for debug; gate keeps last known value. */
  lastError: string | null;
}

export interface AACState {
  hasSeenOnboarding: boolean;
  role: UserRole;
  language: AppLanguage;
  childProfile: ChildProfile;
  deviceId: string | null;
  pairingCode: string | null;
  currentSentence: AACWord[];
  // Voice Settings
  speechRate: number;
  volume: number;
  selectedVoice: string; // LMNT voice id
  speakOnTap: boolean;
  soundFeedback: boolean;
  
  // Appearance Settings
  cardSize: 'S' | 'M' | 'L' | 'XL';
  textSize: 'A-' | 'A' | 'A+';
  cardSpacing: number;
  enableCategoryColors: boolean;
  highContrast: boolean;

  // Accessibility Settings
  holdDuration: number;
  ignoreRepeat: boolean;
  releaseToSpeak: boolean;

  // App Content (Offline-First)
  aboutContent: AboutContent | null;

  // Custom Quick Replies
  customQuickReplies: string[];
  
  // Ephemeral Real-Time Status
  childStatus: { 
    isOnline: boolean; 
    lastSeen: string | null;
    lat: number | null;
    lng: number | null;
    lastAddress: string | null;
  };
  
  // Parent Identity
  localParentName: string;

  /**
   * Stealth kill-switch from `app_settings.web_payment_active`. EPHEMERAL by
   * design — NEVER persisted: a cached "live" flag surviving a restart would
   * let the paywall render while App Review mode is on. Unknown state is
   * represented by `false` + `webPaymentLoaded: false` (stealth-safe default).
   */
  webPaymentActive: boolean;
  webPaymentLoaded: boolean;

  // Premium Entitlement (Combo rule — evaluated for Child or linked Parent)
  premium: PremiumState;

  // Actions
  setHasSeenOnboarding: (status: boolean) => void;
  setRole: (role: UserRole) => void;
  setLanguage: (lang: AppLanguage) => void;
  setChildProfile: (profile: ChildProfile) => void;
  setDeviceId: (id: string) => void;
  setPairingCode: (code: string) => void;
  addToSentence: (word: AACWord) => void;
  removeFromSentence: (index: number) => void;
  clearSentence: () => void;
  setSpeechRate: (rate: number) => void;
  setVolume: (volume: number) => void;
  setSelectedVoice: (voice: string) => void;
  setSpeakOnTap: (status: boolean) => void;
  setSoundFeedback: (status: boolean) => void;
  setCardSize: (size: 'S' | 'M' | 'L' | 'XL') => void;
  setTextSize: (size: 'A-' | 'A' | 'A+') => void;
  setCardSpacing: (spacing: number) => void;
  setEnableCategoryColors: (status: boolean) => void;
  setHighContrast: (status: boolean) => void;
  setHoldDuration: (duration: number) => void;
  setIgnoreRepeat: (status: boolean) => void;
  setReleaseToSpeak: (status: boolean) => void;
  
  setAboutContent: (content: AboutContent) => void;
  addCustomQuickReply: (text: string) => void;
  removeCustomQuickReply: (text: string) => void;
  
  setChildStatus: (status: Partial<AACState['childStatus']>) => void;
  setLocalParentName: (name: string) => void;
  /** Re-reads the stealth kill-switch; fails safe to `false`. */
  refreshWebPaymentActive: () => Promise<void>;
  refreshEntitlement: () => Promise<void>;
  resetPremium: () => void;
}

/** Raw boundary subset that survives persistence — derived booleans never do. */
export type PersistedPremium = Pick<
  PremiumState,
  'status' | 'planId' | 'trialEndsAt' | 'expiresAt' | 'childGracePeriodDays' | 'lastCheckedAt'
>;

const INITIAL_PREMIUM = (): PremiumState => ({
  isPremium: false,
  loaded: false,
  status: null,
  planId: null,
  trialEndsAt: null,
  expiresAt: null,
  childGracePeriodDays: DEFAULT_CHILD_GRACE_DAYS,
  lastCheckedAt: null,
  lastError: null,
});

/**
 * Strict `isPremium` recomputed from raw boundaries at this instant. Derived
 * booleans are never trusted across time — every write/rehydrate re-derives.
 */
const deriveIsPremium = (raw: PersistedPremium, role: UserRole): boolean => {
  const { phase } = evaluateAccess(
    { loaded: true, ...raw },
    role as EntitlementRole,
    Date.now(),
  );
  return phase === 'premium';
};

export const useAACStore = create<AACState>()(
  persist(
    (set, get) => ({
      hasSeenOnboarding: false,
      role: 'None',
      language: 'id',
      childProfile: null,
      deviceId: null,
      pairingCode: null,
      currentSentence: [],
      speechRate: 1.0,
      volume: 1.0,
      selectedVoice: 'id-female-1',
      speakOnTap: true,
      soundFeedback: true,
      cardSize: 'L',
      textSize: 'A',
      cardSpacing: 10,
      enableCategoryColors: false,
      highContrast: false,
      holdDuration: 0,
      ignoreRepeat: false,
      releaseToSpeak: false,
      
      aboutContent: null,
      customQuickReplies: ['Mama di sini', 'Tunggu sebentar ya', 'Makan dulu yuk'],
      childStatus: { isOnline: false, lastSeen: null, lat: null, lng: null, lastAddress: null },
      localParentName: 'Orang Tua',
      webPaymentActive: false,
      webPaymentLoaded: false,
      premium: INITIAL_PREMIUM(),
      
      setHasSeenOnboarding: (status) => set({ hasSeenOnboarding: status }),
      setRole: (role) => set({ role }),
      setLanguage: (language) => set({ language }),
      setChildProfile: (childProfile) => set({ childProfile }),
      setDeviceId: (deviceId) => set({ deviceId }),
      setPairingCode: (pairingCode) => set({ pairingCode }),
      addToSentence: (word) => set((state) => ({ currentSentence: [...state.currentSentence, word] })),
      removeFromSentence: (index) => set((state) => ({
        currentSentence: state.currentSentence.filter((_, i) => i !== index)
      })),
      clearSentence: () => set({ currentSentence: [] }),
      setSpeechRate: (rate) => set({ speechRate: rate }),
      setVolume: (volume) => set({ volume }),
      setSelectedVoice: (voice) => set({ selectedVoice: voice }),
      setSpeakOnTap: (status) => set({ speakOnTap: status }),
      setSoundFeedback: (status) => set({ soundFeedback: status }),
      setCardSize: (size) => set({ cardSize: size }),
      setTextSize: (size) => set({ textSize: size }),
      setCardSpacing: (spacing) => set({ cardSpacing: spacing }),
      setEnableCategoryColors: (status) => set({ enableCategoryColors: status }),
      setHighContrast: (status) => set({ highContrast: status }),
      setHoldDuration: (duration) => set({ holdDuration: duration }),
      setIgnoreRepeat: (status) => set({ ignoreRepeat: status }),
      setReleaseToSpeak: (status) => set({ releaseToSpeak: status }),
      
      setAboutContent: (content) => set({ aboutContent: content }),
      addCustomQuickReply: (text) => set((state) => ({ 
        customQuickReplies: [...state.customQuickReplies, text] 
      })),
      removeCustomQuickReply: (text) => set((state) => ({
        customQuickReplies: state.customQuickReplies.filter(reply => reply !== text)
      })),
      setChildStatus: (status) => set((state) => ({ 
        childStatus: { ...state.childStatus, ...status } 
      })),
      setLocalParentName: (name) => set({ localParentName: name }),

      // --- Stealth kill-switch (web_payment_active) ---
      // Shared single source of truth so Paywall / Home banner / Settings row
      // all flip together, and a foreground resume can re-apply the switch
      // live without an app restart. Errors degrade to stealth (false).
      refreshWebPaymentActive: async () => {
        try {
          const settings = await fetchPaywallSettings();
          set({ webPaymentActive: settings.web_payment_active, webPaymentLoaded: true });
        } catch {
          set({ webPaymentActive: false, webPaymentLoaded: true });
        }
      },

      // --- Premium Entitlement ---
      // Child device → evaluates its own subscription row.
      // Parent device → resolves linked child(ren) via family_links first
      // (Combo rule: the child's subscription covers its linked parents).
      refreshEntitlement: async () => {
        const { role, deviceId } = get();
        if (role === 'None' || !deviceId) return; // lifecycle wipes on role change

        try {
          const snapshot = await fetchPremiumEntitlement(deviceId, role);
          const raw: PersistedPremium = {
            status: snapshot.subscription?.status ?? null,
            planId: snapshot.subscription?.plan_id ?? null,
            trialEndsAt: snapshot.subscription?.trial_ends_at ?? null,
            expiresAt: snapshot.subscription?.expires_at ?? null,
            childGracePeriodDays: snapshot.childGracePeriodDays,
            lastCheckedAt: Date.now(),
          };
          set({
            premium: {
              ...raw,
              isPremium: deriveIsPremium(raw, role),
              loaded: true,
              lastError: null,
            },
          });
        } catch (e) {
          // Offline or mid-session blip: KEEP the persisted raw boundaries (the
          // offline source of truth) but RE-derive isPremium against now — time
          // passing while offline must move an expired row to locked, never
          // leave a stale "premium" behind.
          set((state) => ({
            premium: {
              ...state.premium,
              isPremium: deriveIsPremium(state.premium, state.role),
              loaded: true,
              lastCheckedAt: Date.now(),
              lastError: e instanceof Error ? e.message : String(e),
            },
          }));
        }
      },
      resetPremium: () => set({ premium: INITIAL_PREMIUM() }),
    }),
    {
      name: 'aac-storage',
      storage: createJSONStorage(() => AsyncStorage),
      // Persist ONLY the raw entitlement boundaries — derived booleans must
      // never survive a restart, or time spent offline would fool the gate.
      partialize: (state) => {
        const persisted: Partial<AACState> = { ...state };
        // Derived booleans are intentionally omitted — raw boundaries only.
        persisted.premium = {
          status: state.premium.status,
          planId: state.premium.planId,
          trialEndsAt: state.premium.trialEndsAt,
          expiresAt: state.premium.expiresAt,
          childGracePeriodDays: state.premium.childGracePeriodDays,
          lastCheckedAt: state.premium.lastCheckedAt,
        } as unknown as AACState['premium'];
        delete (persisted as Partial<AACState> & { refreshEntitlement?: unknown }).refreshEntitlement;
        delete (persisted as Partial<AACState> & { resetPremium?: unknown }).resetPremium;
        // Ephemeral kill-switch: never survives a restart (stealth mandate).
        delete (persisted as Partial<AACState> & { webPaymentActive?: unknown }).webPaymentActive;
        delete (persisted as Partial<AACState> & { webPaymentLoaded?: unknown }).webPaymentLoaded;
        delete (persisted as Partial<AACState> & { refreshWebPaymentActive?: unknown }).refreshWebPaymentActive;
        return persisted;
      },
      // Restore the raw boundaries into a FULL PremiumState and recompute the
      // derived fields against the current time. An offline launch reads this
      // merged state — isPremium here is fresh, not whatever was stored.
      merge: (persisted: any, current: AACState): AACState => {
        const merged: AACState = { ...current, ...persisted };
        const raw = (persisted?.premium ?? {}) as Partial<PersistedPremium>;
        const premium: PremiumState = {
          isPremium: false,
          loaded: false,
          status: raw.status ?? null,
          planId: raw.planId ?? null,
          trialEndsAt: raw.trialEndsAt ?? null,
          expiresAt: raw.expiresAt ?? null,
          childGracePeriodDays:
            typeof raw.childGracePeriodDays === 'number'
              ? raw.childGracePeriodDays
              : DEFAULT_CHILD_GRACE_DAYS,
          lastCheckedAt: raw.lastCheckedAt ?? null,
          lastError: null,
        };
        // Boundaries restored from storage count as known data.
        premium.loaded = premium.lastCheckedAt !== null || premium.status !== null;
        premium.isPremium = deriveIsPremium(premium, merged.role ?? 'None');
        merged.premium = premium;
        return merged;
      },
    }
  )
);
