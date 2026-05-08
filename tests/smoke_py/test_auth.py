"""
Smoke tests — Authentication
Verifies the full login flow and that session state persists correctly.
"""
from playwright.sync_api import Page, expect


def test_authenticated_session_reaches_dashboard(page: Page, base_url: str):
    """Auth state from conftest should land us directly on the dashboard."""
    page.goto(f"{base_url}/dashboard")
    expect(page.get_by_role("heading", name="Dashboard")).to_be_visible()


def test_unauthenticated_redirect_to_login(page: Page, base_url: str):
    """A fresh context (no auth state) should redirect to /login."""
    # Create a fresh context with no storage state
    fresh_ctx = page.context.browser.new_context()
    fresh_page = fresh_ctx.new_page()
    fresh_page.goto(f"{base_url}/dashboard")
    expect(fresh_page).to_have_url(f"{base_url}/login")
    fresh_ctx.close()


def test_sign_out_redirects_to_login(page: Page, base_url: str):
    """Signing out should return to /login."""
    page.goto(f"{base_url}/dashboard")
    page.get_by_role("button", name="Sign out").click()
    expect(page).to_have_url(f"{base_url}/login")
