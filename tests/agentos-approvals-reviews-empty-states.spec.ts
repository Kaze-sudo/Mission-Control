import { test, expect, type Page } from '@playwright/test'
import { createTestUser, deleteTestUser } from './helpers'

/**
 * Focused regression - Approvals and Review Queue empty/error state honesty
 * (MC-H08 Approvals/Reviews portions).
 *
 * Contracts covered on /approvals and /reviews:
 *   - A failed first read renders the role=alert (its payload error names the
 *     failure) and NEVER renders the "no work ..." claim - a failed read is
 *     not a truthful zero.
 *   - A healthy read that truly returns empty renders the no-work claim and
 *     no alert (a genuine 0 stays a genuine 0).
 *   - A healthy read with items renders the item card plus the live count
 *     badge, with no alert.
 *   - The filter tabs produce the distinct filtered-empty message, never the
 *     no-work claim.
 *   - Recovery: reloading after the endpoint is restored shows the healthy
 *     state with the alert gone.
 *
 * Run: pnpm exec playwright test tests/agentos-approvals-reviews-empty-states.spec.ts
 * (playwright.config.ts boots the isolated local mock harness on port 3005.)
 */

const OPERATOR_PASS = 'approval-reviews-states-e2e-pass-1!!'

let operator: { id: number; username: string } | null = null

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

const approvalsHealthyZero = { ok: true, items: [], summary: { total: 0, byStatus: {} } }
const reviewsHealthyZero = { ok: true, items: [], summary: { total: 0, awaitingHumanReview: 0, aegisReviewing: 0 } }

const approvalItem = {
  objectiveId: 8001,
  projectId: 2,
  projectName: 'Approval E2E Project',
  objectiveTitle: 'Approvals empty-states regression objective',
  objectiveStatus: 'active',
  planStatus: 'ready',
  planId: 'plan-e2e-approvals-1',
  fingerprint: 'fp-e2e-approvals-0001',
  approvalStatus: 'NONE',
  approvedBy: null,
  approvedAt: null,
  missionCounts: { total: 3, free: 2, paid: 1, unknownCost: 0, blocked: 0, requiresApproval: 1 },
  estimatedTotalCost: null,
  maximumTotalExposure: null,
  approvalRequiredMissions: [],
  createdAt: 1700000000,
  updatedAt: 1700000100,
}
const approvalsHealthyOne = {
  ok: true,
  items: [approvalItem],
  summary: { total: 1, byStatus: { NONE: 1 } },
}

const reviewItem = {
  taskId: 7788,
  taskTitle: 'Reviews empty-states regression sample',
  taskStatus: 'review',
  projectId: null,
  projectName: null,
  objectiveId: null,
  objectiveTitle: null,
  review: null,
  delegation: null,
  createdAt: 1700000000,
  updatedAt: 1700000050,
}
const reviewsHealthyOne = {
  ok: true,
  items: [reviewItem],
  summary: { total: 1, awaitingHumanReview: 1, aegisReviewing: 0 },
}

const APPROVALS_NOWORK_MSG =
  'No work is waiting for approval. Plans requiring approval will appear here.'
const REVIEWS_NOWORK_MSG =
  'No work is awaiting review. Executor output routed into review will appear here.'

test.beforeAll(async ({ request }) => {
  operator = await createTestUser(request, { role: 'admin', password: OPERATOR_PASS })
})

test.afterAll(async ({ request }) => {
  if (operator) await deleteTestUser(request, operator.id).catch(() => {})
})

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill(operator!.username)
  await page.getByLabel('Password').fill(OPERATOR_PASS)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/$/)
}

/**
 * Open a panel after login. The first-visit onboarding dialog can render after
 * the panel heading does - wait for either, dismiss the dialog when it shows,
 * then require the panel heading itself before any behavior assertions.
 */
async function openPanel(page: Page, path: string, headingName: string) {
  await page.goto(path)
  const heading = page.getByRole('heading', { name: headingName })
  const onboarding = page.getByRole('dialog', { name: /Mission Control onboarding/i })
  const skip = onboarding.getByRole('button', { name: 'Skip setup' })
  // New test users start in the essential interface mode; non-essential panels
  // (Approvals, Review Queue) render a "Switch to Full" nudge instead of the
  // panel. Wait for whichever shows first, then clear both blockers.
  const fullNudge = page.getByRole('button', { name: 'Switch to Full' })
  await expect(heading.or(skip).or(fullNudge)).toBeVisible({ timeout: 15_000 })
  if (await skip.isVisible().catch(() => false)) {
    await skip.click()
    await expect(onboarding).toBeHidden({ timeout: 15_000 })
  }
  if (await fullNudge.isVisible().catch(() => false)) {
    await fullNudge.click()
    await expect(heading).toBeVisible()
  }
  await expect(heading).toBeVisible()
}

test.describe('Approvals panel state honesty (MC-H08 Approvals portion)', () => {
  test('failed first read shows the alert, never the no-work claim; reload recovers', async ({ page }) => {
    await page.route('**/api/agentos/approvals*', route =>
      route.fulfill(json({ error: 'simulated approvals queue read failure' }, 500)))
    await login(page)
    await openPanel(page, '/approvals', 'Approvals')

    const nowWork = page.getByText(APPROVALS_NOWORK_MSG)

    // The alert names the failure; the falsifying "no work" claim is absent.
    const alert = page.getByRole('alert').filter({ hasText: 'simulated approvals queue read failure' })
    await expect(alert).toBeVisible()
    await expect(page.getByText('No work is waiting for approval')).toHaveCount(0)

    // Reload after the endpoint is restored: healthy truthful zero.
    await page.route('**/api/agentos/approvals*', route => route.fulfill(json(approvalsHealthyZero)))
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible()
    await expect(nowWork).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: /read failure|Failed to load/ })).toHaveCount(0)
  })

  test('healthy single item renders its card and count badge', async ({ page }) => {
    await page.route('**/api/agentos/approvals*', route => route.fulfill(json(approvalsHealthyOne)))
    await login(page)
    await openPanel(page, '/approvals', 'Approvals')

    await expect(page.getByRole('alert').filter({ hasText: /read failure|Failed to load/ })).toHaveCount(0)
    await expect(page.getByText('Approvals empty-states regression objective')).toBeVisible()
    await expect(page.getByText(/1 waiting/)).toBeVisible()
    await expect(page.getByText(APPROVALS_NOWORK_MSG)).toHaveCount(0)

    // A filter tab that matches nothing yields the distinct filtered-empty
    // message - never the no-work claim - and switching back restores the card.
    await page.getByRole('button', { name: /Stale/ }).click()
    await expect(page.getByText('No items match the "STALE" filter.')).toBeVisible()
    await expect(page.getByText('Approvals empty-states regression objective')).toHaveCount(0)
    await expect(page.getByText('No work is waiting for approval')).toHaveCount(0)
    await page.getByRole('button', { name: 'All', exact: true }).click()
    await expect(page.getByText('Approvals empty-states regression objective')).toBeVisible()
  })
})

test.describe('Review Queue panel state honesty (MC-H08 Reviews portion)', () => {
  test('failed first read shows the alert, never the no-work claim; reload recovers', async ({ page }) => {
    await page.route('**/api/agentos/reviews*', route =>
      route.fulfill(json({ error: 'simulated review queue read failure' }, 500)))
    await login(page)
    await openPanel(page, '/reviews', 'Review Queue')

    // The alert names the failure; the falsifying "no work" claim is absent.
    const alert = page.getByRole('alert').filter({ hasText: 'simulated review queue read failure' })
    await expect(alert).toBeVisible()
    await expect(page.getByText('No work is awaiting review')).toHaveCount(0)

    // Reload after the endpoint is restored: healthy truthful zero.
    await page.route('**/api/agentos/reviews*', route => route.fulfill(json(reviewsHealthyZero)))
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Review Queue' })).toBeVisible()
    await expect(page.getByText(REVIEWS_NOWORK_MSG)).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: /read failure|Failed to load/ })).toHaveCount(0)
  })

  test('healthy single item renders its card and count badge; Aegis filter is filtered-empty', async ({ page }) => {
    await page.route('**/api/agentos/reviews*', route => route.fulfill(json(reviewsHealthyOne)))
    await login(page)
    await openPanel(page, '/reviews', 'Review Queue')

    await expect(page.getByRole('alert').filter({ hasText: /read failure|Failed to load/ })).toHaveCount(0)
    await expect(page.getByText('Reviews empty-states regression sample')).toBeVisible()
    await expect(page.getByText(/1 in review/i)).toBeVisible()
    await expect(page.getByText(REVIEWS_NOWORK_MSG)).toHaveCount(0)

    // The item is taskStatus 'review'; the Aegis review tab matches nothing.
    await page.getByRole('button', { name: /Aegis review/ }).click()
    await expect(page.getByText('No items match the "quality_review" filter.')).toBeVisible()
    await expect(page.getByText('Reviews empty-states regression sample')).toHaveCount(0)
    await expect(page.getByText('No work is awaiting review')).toHaveCount(0)
    await page.getByRole('button', { name: 'All', exact: true }).click()
    await expect(page.getByText('Reviews empty-states regression sample')).toBeVisible()
  })
})
