import { useCallback, useEffect, useRef } from 'react';
import * as Haptics from 'expo-haptics';

/**
 * useTapGuard — the child-mode "triple tap" safety gate.
 *
 * WHY taps instead of a long press
 * --------------------------------
 * Holding a finger steady for N seconds is the hardest gesture for the exact
 * users this app serves: children with motor-skill / tremor challenges, and
 * users with spasticity. A hold either never registers or registers by
 * accident while resting a palm. Three deliberate taps are easier to perform
 * on purpose and much harder to trigger by a stray hand brushing the screen —
 * which is why the Settings entry and the category bar both use this gate now,
 * mirroring each other (one rule the child can learn once).
 *
 * Behaviour
 *   • Each accepted tap advances the counter and fires a light impact haptic,
 *     so the child feels progress ("1 … 2 … 3").
 *   • `onProgress` reports (count, remaining) — screens surface "N taps left".
 *   • Reaching the target fires a success haptic and `onComplete`, then resets.
 *   • A streak older than `windowMs` restarts at 1 on the next tap, so a tap
 *     from a minute ago can never "help" complete the gesture.
 *   • Per-instance state (useRef): category A's two taps never unlock
 *     category B, and the Settings gate is independent of the tabs.
 */
export const DEFAULT_TAP_GATE_TAPS = 3;
export const DEFAULT_TAP_GATE_WINDOW_MS = 2500;

export interface UseTapGuardOptions {
  /** Required taps. Default 3. */
  taps?: number;
  /** A streak resets when the gap from its FIRST tap exceeds this. Default 2500ms. */
  windowMs?: number;
  /** Fired once the required taps land inside the window. */
  onComplete: () => void;
  /** Fired after every intermediate tap: (accepted, remaining). */
  onProgress?: (count: number, remaining: number) => void;
  /** Tactile feedback (light impact per tap, success on completion). Default true. */
  haptics?: boolean;
}

export function useTapGuard({
  taps = DEFAULT_TAP_GATE_TAPS,
  windowMs = DEFAULT_TAP_GATE_WINDOW_MS,
  onComplete,
  onProgress,
  haptics = true,
}: UseTapGuardOptions): () => void {
  // Latest-ref: the returned callback stays stable across renders while always
  // calling the freshest handlers (navigation object, i18n `t`, etc.).
  const handlersRef = useRef({ onComplete, onProgress });
  useEffect(() => {
    handlersRef.current = { onComplete, onProgress };
  });

  const countRef = useRef(0);
  const firstTapAtRef = useRef(0);

  return useCallback(() => {
    const now = Date.now();
    if (countRef.current > 0 && now - firstTapAtRef.current > windowMs) {
      // Streak expired — this tap starts a new one.
      countRef.current = 0;
    }
    if (countRef.current === 0) firstTapAtRef.current = now;
    countRef.current += 1;

    if (countRef.current >= taps) {
      countRef.current = 0;
      firstTapAtRef.current = 0;
      if (haptics) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      handlersRef.current.onComplete();
      return;
    }

    if (haptics) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    handlersRef.current.onProgress?.(countRef.current, taps - countRef.current);
  }, [taps, windowMs, haptics]);
}
