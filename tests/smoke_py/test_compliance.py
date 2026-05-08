"""
Compliance module smoke tests (Python/pytest).
Verifies: page load, tab navigation, compliance item create round-trip,
insurance tab navigation.
Hits real Supabase — no mocks.
"""
import time
from playwright.sync_api import Page, expect


def test_compliance_page_loads(page: Page, base_url: str):
    """Compliance page renders the correct heading."""
    page.goto(f"{base_url}/compliance")
    expect(page.get_by_role("main").get_by_role("heading", name="Compliance")).to_be_visible()


def test_compliance_tabs_present(page: Page, base_url: str):
    """Both tabs are present and switching works."""
    page.goto(f"{base_url}/compliance")
    expect(page.get_by_role("button", name="Compliance Items")).to_be_visible()
    expect(page.get_by_role("button", name="Insurance Policies")).to_be_visible()

    # Switch to Insurance
    page.get_by_role("button", name="Insurance Policies").click()
    expect(page.get_by_role("button", name="Add policy")).to_be_visible()

    # Switch back
    page.get_by_role("button", name="Compliance Items").click()
    expect(page.get_by_role("button", name="Add item")).to_be_visible()


def test_compliance_rag_summary(page: Page, base_url: str):
    """RAG summary strip shows Red, Amber, Green counters."""
    page.goto(f"{base_url}/compliance")
    expect(page.get_by_role("main").get_by_text("Red")).to_be_visible()
    expect(page.get_by_role("main").get_by_text("Amber")).to_be_visible()
    expect(page.get_by_role("main").get_by_text("Green")).to_be_visible()


def test_compliance_item_create_round_trip(page: Page, base_url: str):
    """Create a compliance item and verify it appears in the list."""
    marker = f"Py2 CI {int(time.time() * 1000)}"
    page.goto(f"{base_url}/compliance")

    # Open form
    page.get_by_role("button", name="Add item").click()
    expect(page.get_by_role("heading", name="New compliance item")).to_be_visible()

    # Select first real property
    page.get_by_label("Property *").select_option(index=1)

    # Fill description
    page.get_by_label("Description *").fill(marker)

    # Set expiry date
    page.get_by_label("Expiry date").fill("2027-12-31")

    # Submit
    page.get_by_role("button", name="Save item").click()

    # Form closes and item appears in table
    expect(page.get_by_role("heading", name="New compliance item")).not_to_be_visible()
    expect(page.get_by_role("main").get_by_text(marker)).to_be_visible()
