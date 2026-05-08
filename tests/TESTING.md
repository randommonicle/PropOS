# PropOS — Testing Strategy

Both test runners hit real Supabase. No mocks. Both must pass before any phase is declared complete.

---

## Runner 1: Playwright (Node.js) — `app/tests/smoke/`

```cmd
cd app
npm run test:smoke           # headless (standard — run after every change)
npm run test:smoke:headed    # visible browser (debugging)
npm run test:smoke:ui        # interactive Playwright UI
npm run test:smoke:report    # open last HTML report
```

Dev server starts automatically if not running (reuses existing at localhost:5173).
Auth state saved to `app/tests/.auth/user.json`.

| File | Tests |
|------|-------|
| `auth.setup.ts` | Login flow, JWT hook, dashboard redirect |
| `dashboard.spec.ts` | Firm name, stat cards, no 401s, sidebar nav |
| `properties.spec.ts` | List load, seed data, create property round-trip |
| `documents.spec.ts` | Page load, upload button, type filter |
| `compliance.spec.ts` | Page load, RAG summary, tabs, compliance item create round-trip |
| `contractors.spec.ts` | Page load, sidebar nav, contractor create round-trip |
| `works.spec.ts` | Page load, tabs, works order create, S20 consultation create |

---

## Runner 2: pytest + Playwright (Python) — `tests/smoke_py/`

```cmd
python -m pytest tests/smoke_py/ -v
```

Dev server must be running first: `cd app && npm run dev`

Python: 3.14.4 · pytest: 9.0.3 · playwright: 1.59.0

| File | Tests |
|------|-------|
| `test_auth.py` | Authenticated session, unauthenticated redirect, sign out |
| `test_dashboard.py` | Firm name, stat cards, no 401s, sidebar nav |
| `test_properties.py` | List load, seed data, create property round-trip |
| `test_documents.py` | Page load, upload button, type filter |
| `test_compliance.py` | Page load, RAG summary, tabs, compliance item create round-trip |
| `test_contractors.py` | Page load, sidebar nav, contractor create round-trip |
| `test_works.py` | Page load, tabs, works order create, S20 consultation create |

---

## When to run both

Run both suites after every significant change and before declaring any phase complete. Node catches front-end regressions fast (auto-starts server). Python acts as independent verification and is the foundation for future DB integrity tests via psycopg2.

---

## Future additions

- **psycopg2 DB integrity tests** — direct Postgres assertions (row counts, FK integrity, RLS verification without going through the UI). Add to `tests/smoke_py/` once psycopg2 is installed.
- **Phase 3+ coverage** — add specs for each module as it ships (financial, portals, BSA, etc.).
