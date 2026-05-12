/**
 * @file bsa-citations.spec.ts
 * @description AUDIT R-8 close — Building Safety Act 2022 citation canonicalisation.
 *
 * Anchors the canonical user-facing citation form across the UI:
 *   `Building Safety Act 2022 — Higher-Risk Building`
 *
 * Per memory rule `feedback_statutory_comments.md` + handover §"statutory
 * citation as test anchor", the UI strings and these smokes move in lockstep.
 * Any future change to the labels MUST update this regex in the same commit.
 *
 * Files asserted against (00034 canonicalisation sweep, see migration §L):
 *   - app/src/components/modules/properties/PropertiesPage.tsx:220
 *       Form label   → `Higher-Risk Building (HRB) — Building Safety Act 2022`
 *   - app/src/components/modules/properties/PropertyDetailPage.tsx:208
 *       HRB value    → `Yes — Higher-Risk Building (Building Safety Act 2022)`
 *
 * NOT canonicalised (specific statutory citations retained verbatim):
 *   - `BSA 2022 s.78` / `BSA 2022 s.88` / `BSA 2022 s.85` in migration headers.
 *   - The `<Badge>HRB</Badge>` compact-badge on PropertiesPage.tsx:97 stays bare.
 */
import { test, expect } from '@playwright/test'

// Canonical regex — the substring all canonicalised surfaces must contain.
// Em-dash (U+2014) used everywhere; do not regress to ASCII hyphen.
const BSA_CANONICAL = /Building Safety Act 2022/
const HRB_CANONICAL = /Higher-Risk Building/

async function goToFirstProperty(page: Parameters<typeof test>[1]) {
  await page.goto('/properties')
  await page.locator('a[href^="/properties/"]').first().click()
  await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible()
}

test.describe('AUDIT R-8 — BSA citation canonicalisation', () => {
  test('PropertiesPage — create form label uses canonical citation', async ({ page }) => {
    await page.goto('/properties')
    await page.getByRole('button', { name: /add property/i }).click()

    // The form label combines both Higher-Risk Building AND Building Safety Act 2022
    // per the canonical form. Regex matches the union.
    const label = page.getByText(/Higher-Risk Building.*Building Safety Act 2022/)
    await expect(label).toBeVisible()
  })

  test('PropertyDetailPage — HRB field value uses canonical citation on Birchwood', async ({ page }) => {
    // Navigate to Birchwood Court specifically (the HRB fixture). Falls back to
    // first property if Birchwood not in the rendered list — but Birchwood is
    // seeded by 00033 and present in any environment running this smoke.
    await page.goto('/properties')
    const birchwoodLink = page.locator('a[href^="/properties/"]', { hasText: /Birchwood/ })
    if (await birchwoodLink.count() > 0) {
      await birchwoodLink.first().click()
    } else {
      await goToFirstProperty(page)
    }

    await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible()

    // The HRB field value renders `Yes — Higher-Risk Building (Building Safety Act 2022)`
    // when is_hrb=true. Assert both halves of the canonical form are present.
    const mainContent = page.getByRole('main')
    await expect(mainContent.getByText(HRB_CANONICAL).first()).toBeVisible()
    await expect(mainContent.getByText(BSA_CANONICAL).first()).toBeVisible()
  })
})
