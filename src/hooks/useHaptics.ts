import * as React from "react"

/**
 * Haptic feedback hook.
 *
 * The web Vibration API is supported on Android Chrome + most mobile
 * browsers, ignored on desktop and iOS Safari (Apple gates haptics
 * behind the Capacitor / PWA shell). We swallow the no-op silently so
 * the call site can fire haptics on every interaction without checks.
 *
 * Patterns:
 *   light()         — single 12 ms tap, when user-initiated action is acknowledged
 *   send()          — single 25 ms buzz, when a message leaves the device
 *   response()      — "tap-tap" pattern (12-60-12 ms), when the AI finishes responding
 *   confirm()       — three short taps, for confirmation-required tool calls
 */
export interface Haptics {
  light: () => void
  send: () => void
  response: () => void
  confirm: () => void
  supported: boolean
}

function safeVibrate(pattern: number | number[]) {
  if (typeof navigator === "undefined") return
  // Vibrate is on Navigator on all supporting browsers. Wrapped in
  // try/catch because some browsers throw if the document isn't visible
  // or if the pattern exceeds an internal max length.
  try {
    navigator.vibrate?.(pattern)
  } catch {
    // ignore — vibration is best-effort
  }
}

export function useHaptics(): Haptics {
  const supported = React.useMemo(
    () => typeof navigator !== "undefined" && typeof navigator.vibrate === "function",
    [],
  )

  return React.useMemo<Haptics>(
    () => ({
      light: () => safeVibrate(12),
      send: () => safeVibrate(25),
      response: () => safeVibrate([12, 60, 12]),
      confirm: () => safeVibrate([10, 40, 10, 40, 10]),
      supported,
    }),
    [supported],
  )
}
