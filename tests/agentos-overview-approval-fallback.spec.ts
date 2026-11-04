import { test, expect, type Page } from '@playwright/test'
import { createTestUser, deleteTestUser } from './helpers'

/**
 * Focused regression — Overview queue counters must be honest about failed
 * companion reads (MC-H08 Overview portion).
 *
 * Pre-fix bug: the Overview panel wraps /api/agentos/runs and
 * /api/agentos/approvals reads in `.catch(() => null)` and maps the null into
 * `?? 0`, so a failed queue read renders as a real-looking 0.
 *
 * Target contract:
 *   - Healthy reads render exact numeric counts (3 active / 4 queued in the
 *     fixtures below).
 *   - A failed read (mocked 500 from the real client contract) renders
 *     'Unavailable' on every counter that depends on that read — never 0.
 *   - A successful read returning a true zero still renders exactly 0.
 *   - Panel Refresh after recovery replaces 'Unavailable' with the real value.
 *
 * Run: pnpm exec playwright test tests/agentos-overview-approval-fallback.spec.ts
 * (playwright.config.ts boots the isolated local mock harness on port 3005.)
 */

const ACTIVE_RUNS = 3
const QUEUED_RUNS = 4
const OPERATOR_PASS = 'overview-e2e-pass-1!!'

let operator: { id: number; username: string } | null = null

const statusPayload = {
  status: {
    asOf: Math.floor(Date.now() / 1000),
    configured: true,
    command: { totalProjects: 1, commanded: 1, states: { active: 1 }, paused: [], blocked: [] },
    platoons: [],
    roster: { discovered: 0, registered: 0, dispatchable: 0, unavailable: 0, classifications: {} },
    execution: {
      objectives: { total: 0, byStatus: {} },
      missions: {
        total: 0, running: 0, queued: 0, held: 0,
        review: 0, done: 0, failed: 0, cancelled: 0, other: 0,
      },
    },
    attention: [],
    timestamps: { lastRosterSeen: null, lastCommandUpdate: null, lastDelegation: null },
  },
}

const runsHealthy = {
  ok: true,
  runs: [],
  summary: { total: ACTIVE_RUNS + QUEUED_RUNS, byState: { RUNNING: ACTIVE_RUNS, QUEUED: QUEUED_RUNS } },
}

const approvalsHealthyZero = { ok: true, items: [], summary: { total: 0, byStatus: {} } }

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

test.beforeAll(async ({ request }) => {
  // Dedicated admin operator so the regression does not depend on seeded creds.
  operator = await createTestUser(request, { role: 'admin', password: OPERATOR_PASS })
})

test.afterAll(async ({ request }) => {
  if (operator) await deleteTestUser(request, operator.id).catch(() => {})
})

async function loginAndOpenOverview(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill(operator!.username)
  await page.getByLabel('Password').fill(OPERATOR_PASS)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/$/)

  // First-visit operator journey: the onboarding dialog may appear after the
  // page loads — wait for either the System Status panel or the dialog,
  // dismiss the dialog when it shows, then wait for the panel itself.
  const panelHeading = page.getByRole('heading', { name: 'System Status', exact: true })
  const onboarding = page.getByRole('dialog', { name: /Mission Control onboarding/i })
  const skip = onboarding.getByRole('button', { name: 'Skip setup' })
  await expect(panelHeading.or(skip)).toBeVisible({ timeout: 15_000 })
  if (await skip.isVisible().catch(() => false)) {
    await skip.click()
    await expect(onboarding).toBeHidden({ timeout: 15_000 })
  }
  // The panel has actually rendered before any behavior assertion is made.
  await expect(panelHeading).toBeVisible()
}

test.describe('Overview queue honest availability (MC-H08 Overview portion)', () => {
  test('failed approvals read: healthy runs stay exact, approvals shows Unavailable, Refresh recovers', async ({ page }) => {
    await page.route('**/api/agentos/status*', route => route.fulfill(json(statusPayload)))
    await page.route('**/api/agentos/runs*', route => route.fulfill(json(runsHealthy)))
    await page.route('**/api/agentos/approvals*', route =>
      route.fulfill(json({ error: 'simulated approval queue read failure' }, 500)))

    await loginAndOpenOverview(page)

    const panel = page.locator('section', {
      has: page.getByRole('heading', { name: 'System Status', exact: true }),
    })
    const approvalsCard = panel.getByRole('button', { name: /approvals waiting/i })
    const activeRunsCard = panel.getByRole('button', { name: /active runs/i })
    const queuedCard = panel.getByRole('button', { name: /queued/i })

    // Healthy reads first: exact, card-specific counts.
    await expect(approvalsCard).toBeVisible()
    await expect(activeRunsCard).toBeVisible()
    await expect(queuedCard).toBeVisible()
    await expect(activeRunsCard).toContainText('3')
    await expect(queuedCard).toContainText('4')

    // Failure contract: approvals must show Unavailable — never a 0 that
    // could be mistaken for a real empty queue.
    await expect(approvalsCard).toContainText('Unavailable')
    await expect(approvalsCard.getByText(/^0$/)).toHaveCount(0)

    // Recovery through the panel's existing Refresh control.
    await page.route('**/api/agentos/approvals*', route =>
      route.fulfill(json(approvalsHealthyZero)))
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(approvalsCard.getByText('0', { exact: true })).toBeVisible()
    await expect(approvalsCard.getByText('Unavailable')).toHaveCount(0)
    // The failed read's neighbors are never touched by the recovery.
    await expect(activeRunsCard).toContainText('3')
    await expect(queuedCard).toContainText('4')
  })

  test('failed runs read: only runs-dependent counters show Unavailable, approvals stays exact', async ({ page }) => {
    await page.route('**/api/agentos/status*', route => route.fulfill(json(statusPayload)))
    await page.route('**/api/agentos/runs*', route =>
      route.fulfill(json({ error: 'simulated runs read failure' }, 500)))
    await page.route('**/api/agentos/approvals*', route =>
      route.fulfill(json(approvalsHealthyZero)))

    await loginAndOpenOverview(page)

    const panel = page.locator('section', {
      has: page.getByRole('heading', { name: 'System Status', exact: true }),
    })
    const approvalsCard = panel.getByRole('button', { name: /approvals waiting/i })
    const activeRunsCard = panel.getByRole('button', { name: /active runs/i })
    const queuedCard = panel.getByRole('button', { name: /queued/i })
    const failedCard = panel.getByRole('button', { name: /failed/i })

    // A successful, genuinely empty approvals read still shows a truthful 0.
    await expect(approvalsCard).toBeVisible()
    await expect(approvalsCard.getByText('0', { exact: true })).toBeVisible()
    await expect(approvalsCard.getByText('Unavailable')).toHaveCount(0)

    // Every counter fed by the failed runs read shows Unavailable.
    for (const card of [activeRunsCard, queuedCard, failedCard]) {
      await expect(card).toBeVisible()
      await expect(card).toContainText('Unavailable')
      await expect(card.getByText(/^0$/)).toHaveCount(0)
    }

    // Recovery: refresh replaces Unavailable with the real values.
    await page.route('**/api/agentos/runs*', route => route.fulfill(json(runsHealthy)))
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(activeRunsCard).toContainText('3')
    await expect(queuedCard).toContainText('4')
    await expect(activeRunsCard.getByText('Unavailable')).toHaveCount(0)
    await expect(queuedCard.getByText('Unavailable')).toHaveCount(0)
  })
})
