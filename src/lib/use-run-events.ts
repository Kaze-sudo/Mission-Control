'use client'

import { useEffect, useRef } from 'react'

/**
 * Refresh-on-event hook for run-feed surfaces (Runs, Agent Registry recent
 * executions). The app-wide SSE hook (`useServerEvents`) forwards every
 * `task.*` and `delegation.*` server event as a window `mc:run-events`
 * CustomEvent; this hook debounces those into a single reload so execution
 * state appears instantly instead of waiting for the next poll tick. No
 * extra SSE connection is opened — one connection is shared app-wide.
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
    window.addEventListener('mc:run-events', handler)
    return () => {
      window.removeEventListener('mc:run-events', handler)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [debounceMs])
}