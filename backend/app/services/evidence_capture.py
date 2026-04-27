import os
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import uuid4

from app.core.config import settings
from app.core.storage import upload_file
from app.models.company import Company


@dataclass
class EvidenceSnapshot:
    url: str
    source_url: str
    captured_at: str


def _google_ads_url(company: Company) -> str:
    customer_id = "".join(char for char in (company.google_ads_customer_id or "") if char.isdigit())
    if customer_id:
        return f"https://ads.google.com/aw/overview?ocid={customer_id}"
    return "https://ads.google.com/"


def _google_analytics_url(company: Company) -> str:
    property_id = "".join(char for char in (company.ga4_property_id or "") if char.isdigit())
    if property_id:
        return f"https://analytics.google.com/analytics/web/#/p{property_id}/reports/intelligenthome"
    return "https://analytics.google.com/"


def _source_url(source_mode: str, company: Company) -> str:
    if source_mode == "google_ads":
        return _google_ads_url(company)
    if source_mode == "google_analytics":
        return _google_analytics_url(company)
    raise ValueError(f"Unsupported evidence source mode: {source_mode}")


async def capture_marketing_evidence_snapshot(
    *,
    source_mode: str,
    company: Company,
    user_query: str,
) -> EvidenceSnapshot:
    """Capture a best-effort browser evidence screenshot for Google marketing reports."""
    user_data_dir = os.path.expandvars(os.path.expanduser(settings.evidence_browser_user_data_dir))
    if not user_data_dir:
        raise RuntimeError(
            "Evidence capture needs EVIDENCE_BROWSER_USER_DATA_DIR configured to a logged-in browser profile."
        )
    if not os.path.exists(user_data_dir):
        raise RuntimeError(f"Evidence browser profile was not found: {user_data_dir}")

    try:
        from playwright.async_api import async_playwright
    except Exception as exc:
        raise RuntimeError("Playwright is not installed in the backend environment.") from exc

    source_url = _source_url(source_mode, company)
    captured_at = datetime.now(UTC).isoformat()
    key = f"evidence/{company.id}/{datetime.now(UTC):%Y%m%dT%H%M%S}-{uuid4().hex}.png"

    async with async_playwright() as playwright:
        context = await playwright.chromium.launch_persistent_context(
            user_data_dir=user_data_dir,
            channel=settings.evidence_browser_channel or None,
            headless=False,
            viewport={"width": 1440, "height": 1000},
        )
        try:
            page = context.pages[0] if context.pages else await context.new_page()
            await page.goto(source_url, wait_until="domcontentloaded", timeout=60_000)
            await page.wait_for_timeout(5_000)
            screenshot = await page.screenshot(full_page=True)
        finally:
            await context.close()

    public_url = upload_file(screenshot, key, content_type="image/png")
    return EvidenceSnapshot(url=public_url, source_url=source_url, captured_at=captured_at)
