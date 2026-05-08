"""
PropOS Python smoke test configuration.
Logs in once per session using a session-scoped autouse fixture and saves
browser storage state so every test starts pre-authenticated.
Tests are synchronous (sync_api) and headless by default.

Prerequisites: dev server must be running at http://localhost:5173
  cd app && npm run dev
"""
import urllib.request
import pytest
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE_URL = "http://localhost:5173"
AUTH_FILE = Path(__file__).parent / ".auth" / "user.json"

ADMIN_EMAIL = "admin@propos.local"
ADMIN_PASSWORD = "PropOS2026!"


@pytest.fixture(scope="session", autouse=True)
def setup_auth():
    """
    Log in once per session; save browser storage state to AUTH_FILE.
    All tests in the suite depend on this fixture via browser_context_args.
    """
    # Fail fast with a clear message if the dev server isn't up
    try:
        urllib.request.urlopen(BASE_URL, timeout=5)
    except Exception:
        pytest.fail(
            f"Dev server not reachable at {BASE_URL}. "
            "Start it first:  cd app && npm run dev"
        )

    AUTH_FILE.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context()
        page = ctx.new_page()
        page.goto(f"{BASE_URL}/login")
        page.get_by_label("Email").fill(ADMIN_EMAIL)
        page.get_by_label("Password").fill(ADMIN_PASSWORD)
        page.get_by_role("button", name="Sign in").click()
        page.wait_for_url("**/dashboard", timeout=15_000)
        ctx.storage_state(path=str(AUTH_FILE))
        browser.close()


@pytest.fixture(scope="session")
def base_url():
    return BASE_URL


@pytest.fixture(scope="session")
def browser_context_args(browser_context_args, setup_auth):
    """Inject saved auth state into every test's browser context."""
    return {
        **browser_context_args,
        "storage_state": str(AUTH_FILE),
    }
