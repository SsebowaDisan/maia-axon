import os
import re
from dataclasses import dataclass
from datetime import date, timedelta

import httpx
from google.auth.transport.requests import Request
from google.oauth2 import service_account

from app.core.config import settings
from app.models.company import Company
from app.services.answer_engine import AnswerResponse, AnswerSection
from app.services.google_marketing.narrative import build_marketing_narrative

GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords"
GOOGLE_ADS_API_VERSION = "v24"


@dataclass
class GoogleAdsPlan:
    title: str
    dimension: str
    visualization_type: str
    order_by: str
    primary_metric: str
    limit: int = 10


def _normalized_customer_id(value: str | None) -> str:
    return re.sub(r"[^0-9]", "", value or "")


def _parse_date_range(query: str) -> tuple[str, str, str]:
    normalized = query.lower()
    today = date.today()

    if "today" in normalized:
        return today.isoformat(), today.isoformat(), "today"
    if "yesterday" in normalized:
        day = today - timedelta(days=1)
        return day.isoformat(), day.isoformat(), "yesterday"

    explicit = re.search(r"last\s+(\d{1,3})\s+days?", normalized)
    if explicit:
        days = int(explicit.group(1))
        start = today - timedelta(days=max(days - 1, 0))
        return start.isoformat(), today.isoformat(), f"last {days} days"

    if "last week" in normalized:
        start = today - timedelta(days=6)
        return start.isoformat(), today.isoformat(), "last 7 days"
    if "last month" in normalized:
        start = today - timedelta(days=29)
        return start.isoformat(), today.isoformat(), "last 30 days"
    if "last quarter" in normalized:
        start = today - timedelta(days=89)
        return start.isoformat(), today.isoformat(), "last 90 days"

    start = today - timedelta(days=29)
    return start.isoformat(), today.isoformat(), "last 30 days"


def _plan_for_query(query: str) -> GoogleAdsPlan:
    normalized = query.lower()
    if "campaign" in normalized:
        return GoogleAdsPlan(
            title="Campaign performance",
            dimension="campaign.name",
            visualization_type="bar",
            order_by="metrics.cost_micros DESC",
            primary_metric="cost",
        )
    if "device" in normalized or "mobile" in normalized or "desktop" in normalized:
        return GoogleAdsPlan(
            title="Device performance",
            dimension="segments.device",
            visualization_type="bar",
            order_by="metrics.clicks DESC",
            primary_metric="clicks",
        )
    return GoogleAdsPlan(
        title="Ads trend",
        dimension="segments.date",
        visualization_type="line",
        order_by="segments.date ASC",
        primary_metric="impressions",
    )


def _get_access_token() -> str:
    key_path = os.path.expanduser(os.path.expandvars(settings.google_service_account_key_path))
    if not key_path:
        raise ValueError("Google service account key path is not configured")
    if not os.path.exists(key_path):
        raise ValueError("Google service account key file was not found on the backend")

    credentials = service_account.Credentials.from_service_account_file(
        key_path,
        scopes=[GOOGLE_ADS_SCOPE],
    )
    credentials.refresh(Request())
    if not credentials.token:
        raise ValueError("Failed to obtain Google Ads access token")
    return credentials.token


def _format_int(value: float) -> str:
    return f"{int(round(value)):,}"


def _format_float(value: float) -> str:
    return f"{value:,.2f}"


def _extract_error_message(response: httpx.Response) -> str:
    request_id = response.headers.get("request-id") or response.headers.get("google-ads-request-id")
    detail = response.text

    try:
        payload = response.json()
    except Exception:
        payload = None

    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            parts = [error.get("status"), error.get("message")]
            detail = " | ".join(part for part in parts if part) or detail

    if request_id:
        return f"{detail} (request ID: {request_id})"
    return detail


def _query_google_ads(company: Company, query: str) -> list[dict]:
    customer_id = _normalized_customer_id(company.google_ads_customer_id)
    if not customer_id:
        raise ValueError("Google Ads customer ID is missing for the selected company")
    if not settings.google_ads_developer_token:
        raise ValueError("Google Ads developer token is not configured on the backend")

    token = _get_access_token()
    headers = {
        "Authorization": f"Bearer {token}",
        "developer-token": settings.google_ads_developer_token,
        "Content-Type": "application/json",
    }
    login_customer_id = _normalized_customer_id(company.google_ads_login_customer_id)
    if login_customer_id:
        headers["login-customer-id"] = login_customer_id

    url = (
        f"https://googleads.googleapis.com/{GOOGLE_ADS_API_VERSION}/customers/"
        f"{customer_id}/googleAds:searchStream"
    )

    response = httpx.post(url, headers=headers, json={"query": query}, timeout=30.0)
    if response.is_error:
        raise ValueError(_extract_error_message(response))

    payload = response.json()
    rows: list[dict] = []
    for chunk in payload:
        rows.extend(chunk.get("results", []))
    return rows


def _dimension_value(row: dict, dimension: str) -> str:
    if dimension == "segments.date":
        return row.get("segments", {}).get("date") or "(not set)"
    if dimension == "campaign.name":
        return row.get("campaign", {}).get("name") or "(not set)"
    if dimension == "segments.device":
        return row.get("segments", {}).get("device") or "(not set)"
    return "(not set)"


def _dashboard_visualizations(
    *,
    plan: GoogleAdsPlan,
    company_name: str,
    customer_id: str,
    label: str,
    dimension_key: str,
    rows: list[dict],
) -> list[dict]:
    base_meta = {
        "company_name": company_name,
        "source_mode": "google_ads",
        "date_range": label,
        "customer_id": customer_id,
    }
    visualizations = [
        {
            "type": plan.visualization_type,
            "title": plan.title,
            "subtitle": f"{company_name} | {label}",
            "x_key": dimension_key,
            "series": [
                {"key": "impressions", "label": "Impressions"},
                {"key": "clicks", "label": "Clicks"},
                {"key": "conversions", "label": "Conversions"},
            ],
            "rows": rows,
            "meta": base_meta,
        }
    ]

    focus_keys = [plan.primary_metric, "conversions", "ctr_percent"]
    for focus_key in focus_keys:
      if focus_key not in rows[0]:
          continue
      focus_rows = [
          {
              dimension_key: row.get(dimension_key),
              focus_key: row.get(focus_key),
          }
          for row in rows
      ]
      visualizations.append(
          {
              "type": "bar",
              "title": f"{focus_key.replace('_', ' ').title()} focus",
              "subtitle": f"{company_name} | {label}",
              "x_key": dimension_key,
              "series": [{"key": focus_key, "label": focus_key}],
              "rows": focus_rows[:8],
              "meta": base_meta,
          }
      )

    visualizations.append(
        {
            "type": "table",
            "title": "Underlying data",
            "subtitle": f"{company_name} | {label}",
            "x_key": dimension_key,
            "series": [
                {"key": "impressions", "label": "Impressions"},
                {"key": "clicks", "label": "Clicks"},
                {"key": "cost", "label": "Cost"},
                {"key": "conversions", "label": "Conversions"},
            ],
            "rows": rows,
            "meta": base_meta,
        }
    )

    return visualizations


def generate_google_ads_answer(query: str, company: Company) -> AnswerResponse:
    if not company.google_ads_customer_id:
        return AnswerResponse(
            text=f"Google Ads is selected for **{company.name}**, but no Ads customer ID is configured yet.",
            warnings=["Missing Google Ads customer ID for the selected company."],
        )

    plan = _plan_for_query(query)
    start_date, end_date, label = _parse_date_range(query)
    gaql = f"""
        SELECT
          {plan.dimension},
          metrics.impressions,
          metrics.clicks,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value,
          metrics.ctr,
          metrics.average_cpc
        FROM campaign
        WHERE segments.date BETWEEN '{start_date}' AND '{end_date}'
        ORDER BY {plan.order_by}
        LIMIT {plan.limit}
    """

    try:
        rows = _query_google_ads(company, gaql)
    except Exception as exc:
        return AnswerResponse(
            text=f"I could not query Google Ads for **{company.name}** right now.",
            warnings=[str(exc)],
            sections=[AnswerSection(type="explanation", content="Google Ads query failed.", grounded=False)],
        )

    if not rows:
        return AnswerResponse(
            text=f"I connected to Google Ads for **{company.name}**, but no rows were returned for {label}.",
            warnings=["The Google Ads report returned no data."],
            sections=[AnswerSection(type="explanation", content="No data returned.", grounded=False)],
        )

    totals = {
        "impressions": 0.0,
        "clicks": 0.0,
        "cost": 0.0,
        "conversions": 0.0,
        "conversion_value": 0.0,
    }
    viz_rows: list[dict] = []
    summary_rows: list[dict] = []

    dimension_key = "date" if plan.dimension == "segments.date" else "label"

    for index, row in enumerate(rows, start=1):
        metrics = row.get("metrics", {})
        dim_value = _dimension_value(row, plan.dimension)

        impressions = float(metrics.get("impressions", 0) or 0)
        clicks = float(metrics.get("clicks", 0) or 0)
        cost = float(metrics.get("costMicros", 0) or 0) / 1_000_000
        conversions = float(metrics.get("conversions", 0) or 0)
        conversion_value = float(metrics.get("conversionsValue", 0) or 0)
        ctr = float(metrics.get("ctr", 0) or 0)
        average_cpc = float(metrics.get("averageCpc", 0) or 0) / 1_000_000

        totals["impressions"] += impressions
        totals["clicks"] += clicks
        totals["cost"] += cost
        totals["conversions"] += conversions
        totals["conversion_value"] += conversion_value

        viz_rows.append(
            {
                dimension_key: dim_value,
                "impressions": int(round(impressions)),
                "clicks": int(round(clicks)),
                "cost": round(cost, 2),
                "conversions": round(conversions, 2),
                "conversion_value": round(conversion_value, 2),
                "ctr_percent": round(ctr * 100, 2),
                "avg_cpc": round(average_cpc, 2),
            }
        )

        if index <= 5:
            summary_rows.append(
                {
                    "label": dim_value,
                    "metrics": {
                        "impressions": _format_int(impressions),
                        "clicks": _format_int(clicks),
                        "cost": _format_float(cost),
                        "conversions": _format_float(conversions),
                        "ctr": f"{_format_float(ctr * 100)}%",
                    },
                }
            )

    overall_ctr = (totals["clicks"] / totals["impressions"] * 100) if totals["impressions"] else 0.0
    overall_avg_cpc = (totals["cost"] / totals["clicks"]) if totals["clicks"] else 0.0

    text = build_marketing_narrative(
        source_name="Google Ads",
        report_title=plan.title,
        company_name=company.name,
        date_range=label,
        user_query=query,
        primary_metric_key=plan.primary_metric,
        totals_display={
            "impressions": _format_int(totals["impressions"]),
            "clicks": _format_int(totals["clicks"]),
            "cost": _format_float(totals["cost"]),
            "conversions": _format_float(totals["conversions"]),
            "conversion_value": _format_float(totals["conversion_value"]),
            "ctr": f"{_format_float(overall_ctr)}%",
            "avg_cpc": _format_float(overall_avg_cpc),
        },
        top_rows=summary_rows,
    )

    return AnswerResponse(
        text=text,
        sections=[AnswerSection(type="explanation", content=text, grounded=False)],
        visualizations=_dashboard_visualizations(
            plan=plan,
            company_name=company.name,
            customer_id=company.google_ads_customer_id,
            label=label,
            dimension_key=dimension_key,
            rows=viz_rows,
        ),
    )
