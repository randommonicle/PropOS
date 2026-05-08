"""
Smoke tests — Dashboard
Verifies stat cards, firm name, navigation, and absence of auth errors.
"""
from playwright.sync_api import Page, expect


def test_firm_name_in_sidebar(page: Page, base_url: str):
    page.goto(f"{base_url}/dashboard")
    # Sidebar is <aside> (role=complementary)
    expect(
        page.get_by_role("complementary").get_by_text("Demo Property Management Ltd")
    ).to_be_visible()


def test_stat_cards_load(page: Page, base_url: str):
    page.goto(f"{base_url}/dashboard")
    main = page.get_by_role("main")
    # Seed has 3 properties × 3 units = 9 units — unique text on this page
    expect(main.get_by_text("9 units")).to_be_visible()
    expect(main.get_by_text("Open Works Orders")).to_be_visible()
    expect(main.get_by_text("Compliance — Red")).to_be_visible()
    expect(main.get_by_text("Compliance — Amber")).to_be_visible()


def test_no_401_errors(page: Page, base_url: str):
    auth_errors: list[str] = []
    page.on("response", lambda r: auth_errors.append(r.url) if r.status == 401 else None)
    page.goto(f"{base_url}/dashboard")
    page.wait_for_timeout(2_000)
    assert auth_errors == [], f"Unexpected 401 responses: {auth_errors}"


def test_sidebar_nav_links(page: Page, base_url: str):
    page.goto(f"{base_url}/dashboard")
    nav = page.get_by_role("complementary")
    for label in ["Properties", "Compliance", "Works", "Financial", "Documents", "Reports", "Users"]:
        expect(nav.get_by_role("link", name=label)).to_be_visible()
