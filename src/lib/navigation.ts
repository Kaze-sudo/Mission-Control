'use client'

import { useRouter, usePathname } from 'next/navigation'
import { startTransition, useCallback, useEffect } from 'react'
import { startNavigationTiming } from '@/lib/navigation-metrics'
import { projectCommandHref } from '@/lib/project-link'
import { useMissionControl } from '@/store'

export function panelHref(panel: string): string {
  return panel === 'overview' ? '/' : `/${panel}`
}

const PREFETCHED_ROUTES = new Set<string>()
const DEFAULT_PREFETCH_PANELS = [
  'overview',
  'chat',
  'tasks',
  'agents',
  'activity',
  'notifications',
  'tokens',
]

function safePrefetch(router: ReturnType<typeof useRouter>, href: string) {
  if (PREFETCHED_ROUTES.has(href)) return
  PREFETCHED_ROUTES.add(href)
  router.prefetch(href)
}

export function useNavigateToPanel() {
  const router = useRouter()
  const pathname = usePathname()
  const { setActiveTab, setChatPanelOpen } = useMissionControl()

  useEffect(() => {
    for (const panel of DEFAULT_PREFETCH_PANELS) {
      const href = panelHref(panel)
      if (href !== pathname) safePrefetch(router, href)
    }
  }, [pathname, router])

  return useCallback((panel: string) => {
    const href = panelHref(panel)
    if (href === pathname) return
    safePrefetch(router, href)
    startNavigationTiming(pathname, href)
    setActiveTab(panel === 'sessions' ? 'chat' : panel)
    if (panel === 'chat' || panel === 'sessions') {
      setChatPanelOpen(false)
    }
    startTransition(() => {
      router.push(href, { scroll: false })
    })
  }, [pathname, router, setActiveTab, setChatPanelOpen])
}

export function usePrefetchPanel() {
  const router = useRouter()
  return useCallback((panel: string) => {
    const href = panelHref(panel)
    safePrefetch(router, href)
  }, [router])
}

/**
 * Navigate to a specific project's Project Command view. Any project
 * reference across Mission Control should use this (or `projectCommandHref`)
 * so deep links share one routing contract.
 */
export function useNavigateToProjectCommand() {
  const router = useRouter()
  const { setActiveTab } = useMissionControl()

  return useCallback((projectId: number) => {
    const href = projectCommandHref(projectId)
    if (typeof window !== 'undefined' && window.location.pathname + window.location.search === href) return
    safePrefetch(router, href)
    setActiveTab('command')
    startTransition(() => {
      router.push(href, { scroll: false })
    })
  }, [router, setActiveTab])
}
