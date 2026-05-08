"""
Smoke tests — Document Vault
Verifies page load, upload button, and filter controls.
"""
from playwright.sync_api import Page, expect


def test_document_vault_loads(page: Page, base_url: str):
    page.goto(f"{base_url}/documents")
    expect(page.get_by_role("heading", name="Document Vault")).to_be_visible()


def test_upload_button_present(page: Page, base_url: str):
    page.goto(f"{base_url}/documents")
    expect(page.get_by_role("button", name="Upload")).to_be_visible()


def test_type_filter_present(page: Page, base_url: str):
    page.goto(f"{base_url}/documents")
    expect(page.get_by_role("combobox")).to_be_visible()
