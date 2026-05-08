"""
Contractors module smoke tests (Python/pytest).
Verifies: page load, contractor create round-trip.
Hits real Supabase — no mocks.
"""
import time
from playwright.sync_api import Page, expect


def test_contractors_page_loads(page: Page, base_url: str):
    """Contractors page renders the correct heading."""
    page.goto(f"{base_url}/contractors")
    expect(page.get_by_role("main").get_by_role("heading", name="Contractors")).to_be_visible()


def test_contractors_add_button_visible(page: Page, base_url: str):
    """Add contractor button is visible."""
    page.goto(f"{base_url}/contractors")
    expect(page.get_by_role("button", name="Add contractor")).to_be_visible()


def test_contractors_sidebar_nav(page: Page, base_url: str):
    """Contractors nav link is in the sidebar."""
    page.goto(f"{base_url}/contractors")
    expect(page.get_by_role("complementary").get_by_text("Contractors")).to_be_visible()


def test_contractor_create_round_trip(page: Page, base_url: str):
    """Create a contractor and verify it appears in the table."""
    marker = f"Smoke Co {int(time.time() * 1000)}"
    page.goto(f"{base_url}/contractors")

    # Open form
    page.get_by_role("button", name="Add contractor").click()
    expect(page.get_by_role("heading", name="New contractor")).to_be_visible()

    # Fill company name
    page.get_by_label("Company name *").fill(marker)

    # Submit
    page.get_by_role("button", name="Save contractor").click()

    # Form closes and contractor appears in table
    expect(page.get_by_role("heading", name="New contractor")).not_to_be_visible()
    expect(page.get_by_role("main").get_by_text(marker)).to_be_visible()
