"""
Smoke tests — Properties module
Verifies list, seed data, and property creation round-trip.
"""
import time
from playwright.sync_api import Page, expect


def test_properties_list_loads(page: Page, base_url: str):
    page.goto(f"{base_url}/properties")
    expect(page.get_by_role("main").get_by_role("heading", name="Properties")).to_be_visible()


def test_seed_properties_displayed(page: Page, base_url: str):
    page.goto(f"{base_url}/properties")
    for name in ["Maple House", "Birchwood Court", "Cedar Estate"]:
        expect(page.get_by_text(name)).to_be_visible()


def test_create_property(page: Page, base_url: str):
    unique_name = f"Py Smoke Block {int(time.time())}"
    page.goto(f"{base_url}/properties")

    page.get_by_role("button", name="Add property").click()
    expect(page.get_by_role("heading", name="New property")).to_be_visible()

    page.get_by_label("Property name *").fill(unique_name)
    page.get_by_label("Address line 1 *").fill("99 Python Street")
    page.get_by_label("Town *").fill("Bristol")
    page.get_by_label("Postcode *").fill("BS1 9PY")
    page.get_by_role("button", name="Save property").click()

    expect(page.get_by_text(unique_name)).to_be_visible(timeout=10_000)
