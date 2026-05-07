# PropOS — Testing Strategy

## Current: Playwright (Node.js) — headless Chromium E2E smoke tests

Located in `app/tests/smoke/`. Run from the `app/` directory.

```cmd
cd app
npm run test:smoke           # headless (standard)
npm run test:smoke:headed    # with visible browser (debugging)
npm run test:smoke:ui        # interactive Playwright UI
npm run test:smoke:report    # open last HTML report
```

First run installs Playwright browsers automatically.
The dev server starts automatically if not already running (reuses existing).
Auth state is saved to `tests/.auth/user.json` and reused across tests.

### Smoke test coverage

| File | What it tests |
|------|--------------|
| `auth.setup.ts` | Login flow, JWT hook, redirect to dashboard |
| `dashboard.spec.ts` | Stat cards, firm name, no 401s, sidebar nav |
| `properties.spec.ts` | List load, seed data, create property |
| `documents.spec.ts` | Page load, upload UI, filter controls |

### When to run

Run after every significant change to app source. Claude will run this suite
before declaring any Phase 2+ task complete.

---

## Future: pytest + Playwright (Python) — FLAGGED FOR INSTALL

**Status:** Python not yet installed on this machine.

**Why add it:** Python/pytest gives a useful fallback and allows sharing test
infrastructure with data-heavy scripts (migration validation, seed checking,
DB integrity assertions via psycopg2). Some QA tooling integrates better with
Python than Node.

**To set up when Python is installed:**

```cmd
pip install pytest pytest-playwright
playwright install chromium
```

Then mirror the Node smoke tests in `tests/smoke_py/`:
- `conftest.py` — shared fixtures (base_url, auth state)
- `test_auth.py`
- `test_dashboard.py`
- `test_properties.py`
- `test_documents.py`

Both Node and Python suites can run in parallel pointing at the same dev server.
