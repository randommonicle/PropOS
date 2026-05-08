"""
Works module smoke tests (Python/pytest).
Verifies: page load, tab navigation, works order create round-trip,
Section 20 consultation create round-trip.
Hits real Supabase — no mocks.
"""
import time
from playwright.sync_api import Page, expect


def test_works_page_loads(page: Page, base_url: str):
    """Works page renders the correct heading."""
    page.goto(f"{base_url}/works")
    expect(page.get_by_role("main").get_by_role("heading", name="Works")).to_be_visible()


def test_works_tabs_present(page: Page, base_url: str):
    """Both tabs are present and switchable."""
    page.goto(f"{base_url}/works")
    expect(page.get_by_role("button", name="Works Orders")).to_be_visible()
    expect(page.get_by_role("button", name="Section 20")).to_be_visible()

    # Switch to Section 20
    page.get_by_role("button", name="Section 20").click()
    expect(page.get_by_role("button", name="New consultation")).to_be_visible()

    # Switch back
    page.get_by_role("button", name="Works Orders").click()
    expect(page.get_by_role("button", name="New order")).to_be_visible()


def test_works_order_create_round_trip(page: Page, base_url: str):
    """Create a works order and verify it appears in the list."""
    marker = f"Smoke WO {int(time.time() * 1000)}"
    page.goto(f"{base_url}/works")

    # Open form
    page.get_by_role("button", name="New order").click()
    expect(page.get_by_role("heading", name="New works order")).to_be_visible()

    # Select first real property
    page.get_by_label("Property *").select_option(index=1)

    # Fill description
    page.get_by_label("Description *").fill(marker)

    # Submit
    page.get_by_role("button", name="Create order").click()

    # Form closes and order appears in list
    expect(page.get_by_role("heading", name="New works order")).not_to_be_visible()
    expect(page.get_by_role("main").get_by_text(marker)).to_be_visible()


def test_section20_create_round_trip(page: Page, base_url: str):
    """Create a Section 20 consultation and verify it appears in the list."""
    marker = f"Smoke S20 {int(time.time() * 1000)}"
    page.goto(f"{base_url}/works")

    # Switch to Section 20 tab
    page.get_by_role("button", name="Section 20").click()

    # Open form
    page.get_by_role("button", name="New consultation").click()
    expect(page.get_by_role("heading", name="New Section 20 consultation")).to_be_visible()

    # Select first real property
    page.get_by_label("Property *").select_option(index=1)

    # Fill works description
    page.get_by_label("Works description *").fill(marker)

    # Set estimated cost
    page.get_by_label("Estimated cost (£)").fill("50000")

    # Submit
    page.get_by_role("button", name="Create consultation").click()

    # Form closes and consultation appears in the list
    expect(page.get_by_role("heading", name="New Section 20 consultation")).not_to_be_visible()
    expect(page.get_by_role("main").get_by_text(marker)).to_be_visible()
