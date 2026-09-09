'use client'

import { useEffect, useRef } from 'react'

/**
 * Refresh-on-event hook for run-feed surfaces (Runs, Agent Registry recent
 * executions). The app-wide SSE hook (`useServerEvents`) forwards every
 * `task.*` and `delegation.*` server event as a window `mc:run-events`
 * CustomEvent; this hook debounces those into a single reload so execution
 * state appears instantly instead of waiting for the next poll tick. No
 * extra SSE connection is opened — one connection is shared app-wide.
 *
 * The SSE stream is live-only (at-least-once, no replay): events missed during
 * a disconnect cannot be recovered from the stream. On `mc:sse-reconnected`
 * (emitted by `useServerEvents` when the stream comes back after a drop) the
 * hook therefore triggers an immediate convergence refresh — backend reads
 * remain the sole authority for post-disconnect state.
 */
export function useRunEventPulse(onEvent: () => void, debounceMs = 250): void {
  const callbackRef = useRef(onEvent)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    callbackRef.current = onEvent
  }, [onEvent])

  useEffect(() => {
    const handler = () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => callbackRef.current(), debounceMs)
    }
    const reconnectHandler = () => {
      // Missed events are unrecoverable (no replay) — refresh immediately,
      // bypassing the debounce so convergence is not delayed.
      callbackRef.current()
    }
    window.addEventListener('mc:run-events', handler)
    window.addEventListener('mc:sse-reconnected', reconnectHandler)
    return () => {
      window.removeEventListener('mc:run-events', handler)
      window.removeEventListener('mc:sse-reconnected', reconnectHandler)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [debounceMs])
}
