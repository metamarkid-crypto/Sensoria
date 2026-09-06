import { useCallback, useEffect, useRef } from 'react';
import * as Haptics from 'expo-haptics';

/**
 * useAccessibleAction — the AAC-Safe Tremor Filter.
 *
 * Sensoria users include children with motor-skill challenges. A naive
 * `disabled={true}` window or a strict rate-limiter would break two things we
 * can never break:
 *   1. the Accessibility visual contract (no opacity/contrast changes, ever),
 *   2. intentional rapid AAC expression (repeated words ARE communication).
 *
 * This hook is a TREMOR FILTER, not a rate limiter:
 *   • The absorb window is measured from the last ACCEPTED press only — an
 *     absorbed tap never resets the clock. A sustained tremor burst is
 *     swallowed, but the first press after a quiet beat always lands. A rate
 *     limiter counting every raw tap could lock a trembling user out forever.
 *   • Absorbed taps are silent no-ops: no handler, no haptic, no visual
 *     feedback. The button stays fully styled and "active" to the eye and to
 *     screen readers — we never pass `disabled` and never touch styles.
 *   • Accepted taps fire a LIGHT impact haptic immediately: "I felt the buzz ⇒
 *     my press registered", which removes the urge to hammer the button.
 *
 * Hard design contracts:
 *   • TTS-NEUTRAL — the hook wraps only the touch callback. It never calls,
 *     delays, cancels or reorders `playTTS` and knows nothing about the
 *     "Suara & Bicara" state (speechRate, selectedVoice, speakOnTap…).
 *     Queuing/interruption logic in audioManager remains the sole owner.
 *   • ORTHOGONAL to the holdDuration / ignoreRepeat / releaseToSpeak protocol
 *     implemented in AACCard — word cards stay unwrapped (raw taps there are
 *     intentional expression) and this hook never reads those settings.
 *   • PER-INSTANCE isolation — every hook call owns its own window, so
 *     filtering "Bicara" never blocks "Kirim" or a Quick Reply pill.
 */

/** Default absorb window (ms). Taps closer than this to the last accepted press are tremor noise. */
export const DEFAULT_TREMOR_WINDOW_MS = 300;

export interface UseAccessibleActionOptions {
  /**
   * Minimum spacing between ACCEPTED presses in ms. Defaults to
   * DEFAULT_TREMOR_WINDOW_MS (300). Taps inside the window are absorbed.
   */
  minIntervalMs?: number;
  /**
   * Fire a light impact haptic on ACCEPTED presses (tactile confirmation).
   * Default true. Set false for buttons whose handlers already deliver their
   * own immediate haptic feedback (e.g. Bicara / Kirim notification haptics).
   */
  haptics?: boolean;
}

/**
 * Wrap a touch handler with the tremor filter. Generic over the handler's
 * arguments, so parameterized actions survive wrapping:
 *
 *   const speak = useAccessibleAction(handleSpeakAll, { haptics: false });
 *   const reply = useAccessibleAction((text: string) => handleQuickReply(text));
 *   ...
 *   <TouchableOpacity onPress={speak} ... />          // never disabled, never restyled
 *   <TouchableOpacity onPress={() => reply('Oke')} /> // args preserved, typed
 */
export function useAccessibleAction<A extends unknown[] = []>(
  handler: (...args: A) => void | Promise<void>,
  options: UseAccessibleActionOptions = {},
): (...args: A) => void {
  const { minIntervalMs = DEFAULT_TREMOR_WINDOW_MS, haptics = true } = options;

  // Latest-ref pattern: the returned callback stays stable across renders
  // (safe as a direct onPress) while always invoking the freshest handler —
  // no stale sentence-strip/store closures.
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  // Timestamp of the last ACCEPTED press. Absorbed taps deliberately do NOT
  // update it — that is what makes this a filter instead of a rate limiter.
  const lastAcceptedAtRef = useRef(0);

  return useCallback(
    (...args: A) => {
      const now = Date.now();
      if (now - lastAcceptedAtRef.current < minIntervalMs) {
        // Ghost-tap inside the tremor window: absorbed silently. No handler,
        // no haptic, no visual change — the button looks untouched because it
        // IS untouched.
        return;
      }
      lastAcceptedAtRef.current = now;

      if (haptics) {
        // Immediate tactile confirmation on the accepted tap (fire-and-forget —
        // never await haptics inside a touch path).
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }

      void handlerRef.current(...args);
    },
    [minIntervalMs, haptics],
  );
}
