"""
Property detail smoke tests (Python/pytest).
Covers: units CRUD (create, edit, delete with confirmation) and
leaseholders CRUD (create, edit, mark-as-ended, delete with confirmation).
Hits real Supabase — no mocks.
"""
import time
from playwright.sync_api import Page, expect


def go_to_first_property(page: Page, base_url: str) -> None:
    """Navigate to the first property in the list and wait for it to load."""
    page.goto(f"{base_url}/properties")
    page.locator('a[href^="/properties/"]').first().click()
    expect(page.get_by_role("main").get_by_role("heading").first()).to_be_visible()


# ════════════════════════════════════════════════════════════════════════════
# Units
# ════════════════════════════════════════════════════════════════════════════

def test_units_section_visible(page: Page, base_url: str):
    """Units heading and Add unit button are present on the property detail page."""
    go_to_first_property(page, base_url)
    expect(page.get_by_role("main").get_by_text("Units", exact=False).first()).to_be_visible()
    expect(page.get_by_role("button", name="Add unit")).to_be_visible()


def test_unit_create_round_trip(page: Page, base_url: str):
    """Create a unit and verify it appears in the table."""
    marker = f"Smoke U {int(time.time() * 1000)}"
    go_to_first_property(page, base_url)

    page.get_by_role("button", name="Add unit").click()
    expect(page.get_by_role("heading", name="New unit")).to_be_visible()

    page.get_by_label("Unit ref *").fill(marker)
    # Lease term stripped from UnitForm in 00033 (moved to unit_leases).
    page.get_by_role("button", name="Save unit").click()

    expect(page.get_by_role("heading", name="New unit")).not_to_be_visible()
    expect(page.get_by_role("main").get_by_text(marker)).to_be_visible()


def test_unit_edit_round_trip(page: Page, base_url: str):
    """Create a unit, edit it, verify the updated ref appears."""
    original = f"Smoke U Edit {int(time.time() * 1000)}"
    updated  = f"Smoke U Upd  {int(time.time() * 1000)}"
    go_to_first_property(page, base_url)

    # Create
    page.get_by_role("button", name="Add unit").click()
    page.get_by_label("Unit ref *").fill(original)
    page.get_by_role("button", name="Save unit").click()
    expect(page.get_by_role("main").get_by_text(original)).to_be_visible()

    # Edit — find the row and click its first icon button (pencil)
    row = page.get_by_role("main").locator("tr", has=page.get_by_text(original))
    row.get_by_role("button").first().click()
    expect(page.get_by_role("heading", name="Edit unit")).to_be_visible()

    page.get_by_label("Unit ref *").clear()
    page.get_by_label("Unit ref *").fill(updated)
    page.get_by_role("button", name="Update unit").click()

    expect(page.get_by_role("heading", name="Edit unit")).not_to_be_visible()
    expect(page.get_by_role("main").get_by_text(updated)).to_be_visible()


def test_unit_delete_with_confirmation(page: Page, base_url: str):
    """Delete a unit via inline confirmation; verify cancel works before confirming."""
    marker = f"Smoke U Del {int(time.time() * 1000)}"
    go_to_first_property(page, base_url)

    # Create a unit to delete
    page.get_by_role("button", name="Add unit").click()
    page.get_by_label("Unit ref *").fill(marker)
    page.get_by_role("button", name="Save unit").click()
    expect(page.get_by_role("main").get_by_text(marker)).to_be_visible()

    # Click trash button — confirmation should appear
    row = page.get_by_role("main").locator("tr", has=page.get_by_text(marker))
    row.get_by_role("button", name="Delete").click()
    expect(page.get_by_role("button", name="Confirm delete")).to_be_visible()

    # Cancel — unit still there
    page.get_by_role("button", name="Cancel").first().click()
    expect(page.get_by_role("main").get_by_text(marker)).to_be_visible()

    # Confirm delete
    row2 = page.get_by_role("main").locator("tr", has=page.get_by_text(marker))
    row2.get_by_role("button", name="Delete").click()
    page.get_by_role("button", name="Confirm delete").click()
    expect(page.get_by_role("main").get_by_text(marker)).not_to_be_visible()


# ════════════════════════════════════════════════════════════════════════════
# Leaseholders
# ════════════════════════════════════════════════════════════════════════════

def test_leaseholders_section_visible(page: Page, base_url: str):
    """Leaseholders heading and Add leaseholder button are present."""
    go_to_first_property(page, base_url)
    expect(page.get_by_role("main").get_by_text("Leaseholders", exact=False).first()).to_be_visible()
    expect(page.get_by_role("button", name="Add leaseholder")).to_be_visible()


def test_leaseholder_create_round_trip(page: Page, base_url: str):
    """Create a unit, then create a leaseholder on that unit and verify it appears."""
    unit_ref = f"Smoke LH Unit {int(time.time() * 1000)}"
    lh_name  = f"Smoke LH {int(time.time() * 1000)}"
    go_to_first_property(page, base_url)

    # Create supporting unit
    page.get_by_role("button", name="Add unit").click()
    page.get_by_label("Unit ref *").fill(unit_ref)
    page.get_by_role("button", name="Save unit").click()
    expect(page.get_by_role("main").get_by_text(unit_ref)).to_be_visible()

    # Create leaseholder
    page.get_by_role("button", name="Add leaseholder").click()
    expect(page.get_by_role("heading", name="New leaseholder")).to_be_visible()

    page.get_by_label("Unit *").select_option(label=unit_ref)
    page.get_by_label("Full name *").fill(lh_name)
    page.get_by_role("button", name="Save leaseholder").click()

    expect(page.get_by_role("heading", name="New leaseholder")).not_to_be_visible()
    expect(page.get_by_role("main").get_by_text(lh_name)).to_be_visible()


def test_leaseholder_edit_round_trip(page: Page, base_url: str):
    """Create a leaseholder, edit it, verify updated name appears."""
    unit_ref = f"Smoke LH Eu {int(time.time() * 1000)}"
    original = f"LH Edit Orig {int(time.time() * 1000)}"
    updated  = f"LH Edit Upd  {int(time.time() * 1000)}"
    go_to_first_property(page, base_url)

    # Create unit + leaseholder
    page.get_by_role("button", name="Add unit").click()
    page.get_by_label("Unit ref *").fill(unit_ref)
    page.get_by_role("button", name="Save unit").click()

    page.get_by_role("button", name="Add leaseholder").click()
    page.get_by_label("Unit *").select_option(label=unit_ref)
    page.get_by_label("Full name *").fill(original)
    page.get_by_role("button", name="Save leaseholder").click()
    expect(page.get_by_role("main").get_by_text(original)).to_be_visible()

    # Edit
    row = page.get_by_role("main").locator("tr", has=page.get_by_text(original))
    row.get_by_role("button", name="Edit").first().click()
    expect(page.get_by_role("heading", name="Edit leaseholder")).to_be_visible()

    page.get_by_label("Full name *").clear()
    page.get_by_label("Full name *").fill(updated)
    page.get_by_role("button", name="Update leaseholder").click()

    expect(page.get_by_role("heading", name="Edit leaseholder")).not_to_be_visible()
    expect(page.get_by_role("main").get_by_text(updated)).to_be_visible()


def test_leaseholder_mark_as_ended(page: Page, base_url: str):
    """Mark a leaseholder as ended — hidden in current view, visible in historical."""
    unit_ref = f"Smoke LH End {int(time.time() * 1000)}"
    lh_name  = f"LH End {int(time.time() * 1000)}"
    go_to_first_property(page, base_url)

    # Create unit + leaseholder
    page.get_by_role("button", name="Add unit").click()
    page.get_by_label("Unit ref *").fill(unit_ref)
    page.get_by_role("button", name="Save unit").click()

    page.get_by_role("button", name="Add leaseholder").click()
    page.get_by_label("Unit *").select_option(label=unit_ref)
    page.get_by_label("Full name *").fill(lh_name)
    page.get_by_role("button", name="Save leaseholder").click()
    expect(page.get_by_role("main").get_by_text(lh_name)).to_be_visible()

    # Mark as ended
    row = page.get_by_role("main").locator("tr", has=page.get_by_text(lh_name))
    row.get_by_role("button", name="End").click()

    # Disappears from current view
    expect(page.get_by_role("main").get_by_text(lh_name)).not_to_be_visible()

    # Reappears in historical view
    page.get_by_text("Show historical").click()
    expect(page.get_by_role("main").get_by_text(lh_name)).to_be_visible()
    expect(page.get_by_role("main").get_by_text("Ended", exact=False).first()).to_be_visible()


def test_leaseholder_delete_with_confirmation(page: Page, base_url: str):
    """Delete a leaseholder via inline confirmation."""
    unit_ref = f"Smoke LH Del {int(time.time() * 1000)}"
    lh_name  = f"LH Del {int(time.time() * 1000)}"
    go_to_first_property(page, base_url)

    # Create unit + leaseholder
    page.get_by_role("button", name="Add unit").click()
    page.get_by_label("Unit ref *").fill(unit_ref)
    page.get_by_role("button", name="Save unit").click()

    page.get_by_role("button", name="Add leaseholder").click()
    page.get_by_label("Unit *").select_option(label=unit_ref)
    page.get_by_label("Full name *").fill(lh_name)
    page.get_by_role("button", name="Save leaseholder").click()
    expect(page.get_by_role("main").get_by_text(lh_name)).to_be_visible()

    # Delete with confirmation
    row = page.get_by_role("main").locator("tr", has=page.get_by_text(lh_name))
    row.get_by_role("button", name="Delete").click()
    expect(page.get_by_role("button", name="Confirm delete")).to_be_visible()
    page.get_by_role("button", name="Confirm delete").click()

    expect(page.get_by_role("main").get_by_text(lh_name)).not_to_be_visible()
