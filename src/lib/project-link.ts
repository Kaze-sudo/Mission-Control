/**
 * Project deep-linking helpers shared by Mission Control surfaces.
 *
 * Project Command and the surfaces that reference projects (Overview status,
 * Platoons, errors) expose project selection through the URL as
 * `/command?project=<id>` so a view can be bookmarked, shared, and refreshed
 * without losing the selected project. Project ids are stable integers —
 * never display names.
 *
 * This module is deliberately pure (no React, no store) so the parsing and
 * selection rules are unit-testable and every panel uses one contract.
 */

/** Panel id + path segment for Project Command. */
export const PROJECT_COMMAND_PANEL = 'command'

export function projectCommandPath(): string {
  return `/${PROJECT_COMMAND_PANEL}`
}

/** Build the deep-link href for a specific project's Project Command view. */
export function projectCommandHref(projectId: number): string {
  return `${projectCommandPath()}?project=${encodeURIComponent(String(projectId))}`
}

/**
 * Build the deep-link href for a project's Project Command view with the
 * execution preview already opened for one objective
 * (`/command?project=<id>&objective=<id>`). Runs and other surfaces use this
 * to jump straight from a run row to the plan/approval UI for its mission.
 */
export function objectiveCommandHref(projectId: number, objectiveId: number): string {
  return `${projectCommandPath()}?project=${encodeURIComponent(String(projectId))}&objective=${encodeURIComponent(String(objectiveId))}`
}

/**
 * Parse a raw `?objective=` query value into an objective id. Returns a
 * positive integer, or null when absent, malformed, or not a positive safe
 * integer.
 */
export function parseObjectiveQueryParam(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  const trimmed = String(raw).trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * Parse a raw `?project=` query value into a project id. Returns a positive
 * integer, or null when the value is absent, malformed, or not a positive
 * safe integer. Project ids are never inferred from names.
 */
export function parseProjectQueryParam(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  const trimmed = String(raw).trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

export interface ResolveProjectSelectionResult {
  /** The project id Project Command should select (may fall back). */
  selectedId: number | null
  /** True when ?project= pointed at a missing/non-numeric project id. */
  requestedInvalid: boolean
  /** The requested project id when the parameter was present. */
  requestedId: number | null
}

/**
 * Resolve which project a surface should select from the URL parameter and
 * the real project list.
 *
 * - valid param + existing project → select that project;
 * - param present but missing/malformed → `requestedInvalid` with the first
 *   project as a safe fallback;
 * - no param → first project (legacy Project Command behavior), or an
 *   explicit fallback when one is supplied.
 */
export function resolveProjectSelection(input: {
  rawParam: string | null | undefined
  projects: Array<{ id: number }>
  fallbackId?: number | null
}): ResolveProjectSelectionResult {
  const parsed = parseProjectQueryParam(input.rawParam)
  const fallback = input.fallbackId !== undefined && input.fallbackId !== null
    ? input.fallbackId
    : input.projects[0]?.id ?? null
  if (parsed === null) {
    return { selectedId: fallback, requestedInvalid: false, requestedId: null }
  }
  const found = input.projects.some(project => project.id === parsed)
  if (found) return { selectedId: parsed, requestedInvalid: false, requestedId: parsed }
  return { selectedId: fallback, requestedInvalid: true, requestedId: parsed }
}
