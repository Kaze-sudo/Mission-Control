import { test, expect, type Page } from '@playwright/test'
import { createTestUser, deleteTestUser } from './helpers'

/**
 * Focused regression - operator empty states must say why they are empty
 * (MC-H08 Runs/Project Command portions).
 *
 * Contracts covered:
 *   Runs panel (/runs):
 *     - A genuinely empty run feed renders "No AgentOS runs yet...".
 *     - Filters that match nothing render the distinct filtered-empty message
 *       and surface a Clear filters control - never the no-runs-yet copy.
 *     - Clear filters + Refresh restores the unfiltered view and the control
 *       disappears when no filter is active.
 *   Project Command (/command):
 *     - A workspace with zero projects renders the explicit "No projects yet"
 *       empty block, is no longer stuck on "Loading command picture...".
 *
 * Run: pnpm exec playwright test tests/agentos-empty-states.spec.ts
 * (playwright.config.ts boots the isolated local mock harness on port 3005.)
 */

const OPERATOR_PASS = 'empty-states-e2e-pass-1!!'

let operator: { id: number; username: string } | null = null

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

const runsEmpty = { ok: true, runs: [], summary: { total: 0, byState: {} } }

const runsOneRunning = {
  ok: true,
  runs: [{
    id: 'delegation-e2e-empty-states-1',
    kind: 'delegation',
    taskId: 424242,
    taskTitle: 'Empty states regression sample',
    projectId: null,
    projectName: null,
    objectiveId: null,
    objectiveTitle: null,
    objectiveStatus: null,
    delegationId: 'dep-e2e-empty-states-1',
    delegationStatus: 'RUNNING',
    taskStatus: 'in_progress',
    state: 'RUNNING',
    ecosystem: 'offline-mock',
    routingAgentName: 'scout-1',
    specialistName: null,
    attempt: 1,
    nativeSessionId: null,
    nativeRunId: null,
    errorClass: null,
    errorMessage: null,
    resultSummary: null,
    createdAt: 1700000000,
    updatedAt: 1700000160,
    completedAt: null,
    durationSeconds: 160,
    holdReason: null,
    holdCode: null,
  }],
  summary: { total: 1, byState: { RUNNING: 1 } },
}

const NO_RUNS_MSG =
  'No AgentOS runs yet. Plan and execute an objective from Project Command to see live execution here.'
// Dashless prefix of the filtered-empty copy; Playwright text matching is
// substring-based, which keeps the locator independent from punctuation.
const FILTERED_MSG =
  'No AgentOS runs match the current state, project, ecosystem, or agent filters.'

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
  await expect(heading.or(skip)).toBeVisible({ timeout: 15_000 })
  if (await skip.isVisible().catch(() => false)) {
    await skip.click()
    await expect(onboarding).toBeHidden({ timeout: 15_000 })
  }
  await expect(heading).toBeVisible()
}


test.describe('Runs panel empty-state honesty (MC-H08 Runs portion)', () => {
  test('empty feed vs filtered-empty are distinct messages, Clear filters recovers', async ({ page }) => {
    await page.route('**/api/agentos/runs*', route => route.fulfill(json(runsEmpty)))
    await login(page)
    await openPanel(page, '/runs', 'Runs & Execution')

    const clearBtn = page.getByRole('button', { name: 'Clear filters' })
    const noRuns = page.getByText(NO_RUNS_MSG)
    const filtered = page.getByText(FILTERED_MSG)

    // Genuinely empty feed: the no-runs message, and no Clear filters control.
    await expect(noRuns).toBeVisible()
    await expect(filtered).toHaveCount(0)
    await expect(clearBtn).toHaveCount(0)

    // A state filter that matches nothing flips the message to the distinct
    // filtered-empty copy and surfaces Clear filters.
    await page.getByRole('button', { name: 'Failed', exact: true }).click()
    await expect(filtered).toBeVisible()
    await expect(noRuns).toHaveCount(0)
    await expect(clearBtn).toBeVisible()

    // Clear filters restores both the message and the control-less header.
    await clearBtn.click()
    await expect(clearBtn).toHaveCount(0)
    await expect(noRuns).toBeVisible()
    await expect(filtered).toHaveCount(0)
  })

  test('non-matching agent search on a non-empty feed shows filtered-empty, then recovers', async ({ page }) => {
    await page.route('**/api/agentos/runs*', route => {
      const searching = route.request().url().includes('agent=zzz-nomatch')
      return route.fulfill(json(searching ? runsEmpty : runsOneRunning))
    })
    await login(page)
    await openPanel(page, '/runs', 'Runs & Execution')

    const runRow = page.getByText('Empty states regression sample')
    const clearBtn = page.getByRole('button', { name: 'Clear filters' })
    const noRuns = page.getByText(NO_RUNS_MSG)
    const filtered = page.getByText(FILTERED_MSG)

    // Healthy single-run feed first: no empty-state copy at all.
    await expect(runRow).toBeVisible()
    await expect(noRuns).toHaveCount(0)
    await expect(filtered).toHaveCount(0)

    // A search that matches nothing yields the filtered-empty message - never
    // the no-runs-yet copy - and hides the run row.
    const search = page.getByPlaceholder(/Search routing agent \/ specialist/)
    await search.fill('zzz-nomatch')
    await search.press('Enter')
    await expect(filtered).toBeVisible()
    await expect(runRow).toHaveCount(0)
    await expect(noRuns).toHaveCount(0)
    await expect(clearBtn).toBeVisible()

    // Clear filters (control disappears) then the panel Refresh re-queries
    // unfiltered, restoring the run row.
    await clearBtn.click()
    await expect(clearBtn).toHaveCount(0)
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(runRow).toBeVisible()
    await expect(noRuns).toHaveCount(0)
    await expect(filtered).toHaveCount(0)
  })
})

test.describe('Project Command empty state (MC-H08 Project Command portion)', () => {
  test('zero projects renders the explicit no-projects block, not a stuck loading state', async ({ page }) => {
    await page.route('**/api/projects*', route => route.fulfill(json({ projects: [] })))
    await login(page)
    await openPanel(page, '/command', 'Project Command')

    // The no-projects empty block renders (this requires loadContext(null) to
    // clear the loading flag - the panel used to stay on "Loading..." forever).
    const emptyBlock = page.getByText(
      'No projects yet. Create a project, then return here to activate it, bind agents, and control routing policy.')
    await expect(emptyBlock).toBeVisible()
    await expect(page.getByText(/Loading command picture/)).toHaveCount(0)
    await expect(page.getByText(/Failed to load project command view/)).toHaveCount(0)

    // The project select still renders with its explicit No projects option.
    const select = page.getByRole('combobox')
    await expect(select).toBeVisible()
    await expect(select.getByRole('option', { name: 'No projects' })).toHaveCount(1)
  })
})
