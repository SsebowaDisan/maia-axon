import os
import json
import logging
import re
from dataclasses import dataclass

from google.analytics.data_v1beta import BetaAnalyticsDataClient
from google.analytics.data_v1beta.types import DateRange, Dimension, Metric, OrderBy, RunReportRequest
from google.oauth2 import service_account
import openai

from app.core.config import settings
from app.models.company import Company
from app.services.answer_engine import AnswerResponse, AnswerSection
from app.services.google_marketing.date_ranges import parse_date_range
from app.services.google_marketing.narrative import (
    build_dashboard_visualizations_with_llm,
    build_marketing_narrative,
)

GA4_READONLY_SCOPE = "https://www.googleapis.com/auth/analytics.readonly"
logger = logging.getLogger(__name__)


@dataclass
class GA4Plan:
    title: str
    dimensions: list[str]
    metrics: list[str]
    order_metric: str
    visualization_type: str
    limit: int = 10


GA4_PLAN_REGISTRY: dict[str, GA4Plan] = {
    "top_pages": GA4Plan(
        title="Most visited pages",
        dimensions=["pagePathPlusQueryString"],
        metrics=["screenPageViews", "sessions", "activeUsers"],
        order_metric="screenPageViews",
        visualization_type="bar",
    ),
    "landing_pages": GA4Plan(
        title="Top landing pages",
        dimensions=["landingPagePlusQueryString"],
        metrics=["sessions", "activeUsers", "screenPageViews"],
        order_metric="sessions",
        visualization_type="bar",
    ),
    "source_medium": GA4Plan(
        title="Source / medium performance",
        dimensions=["sessionSourceMedium"],
        metrics=["sessions", "activeUsers", "screenPageViews"],
        order_metric="sessions",
        visualization_type="bar",
    ),
    "channel": GA4Plan(
        title="Channel performance",
        dimensions=["sessionPrimaryChannelGroup"],
        metrics=["sessions", "activeUsers", "screenPageViews"],
        order_metric="sessions",
        visualization_type="bar",
    ),
    "campaign": GA4Plan(
        title="Campaign performance",
        dimensions=["sessionCampaignName"],
        metrics=["sessions", "activeUsers", "screenPageViews"],
        order_metric="sessions",
        visualization_type="bar",
    ),
    "geography": GA4Plan(
        title="Geography breakdown",
        dimensions=["country"],
        metrics=["sessions", "activeUsers", "screenPageViews"],
        order_metric="sessions",
        visualization_type="bar",
    ),
    "device": GA4Plan(
        title="Device breakdown",
        dimensions=["deviceCategory"],
        metrics=["sessions", "activeUsers", "screenPageViews"],
        order_metric="sessions",
        visualization_type="bar",
    ),
    "traffic_trend": GA4Plan(
        title="Traffic trend",
        dimensions=["date"],
        metrics=["sessions", "activeUsers", "screenPageViews"],
        order_metric="sessions",
        visualization_type="line",
    ),
}


def _parse_date_range(query: str) -> tuple[str, str, str]:
    return parse_date_range(query)


def _fallback_plan_for_query(query: str) -> GA4Plan:
    normalized = query.lower()

    if (
        "home page" in normalized
        or "homepage" in normalized
        or "which pages" in normalized
        or "most visited page" in normalized
        or "most visited pages" in normalized
        or "pages were visited" in normalized
        or ("page" in normalized and "visited" in normalized)
        or ("pages" in normalized and "most" in normalized)
    ):
        return GA4_PLAN_REGISTRY["top_pages"]
    if "landing" in normalized or "top page" in normalized or "landing page" in normalized:
        return GA4_PLAN_REGISTRY["landing_pages"]
    if "source" in normalized or "medium" in normalized:
        return GA4_PLAN_REGISTRY["source_medium"]
    if "channel" in normalized:
        return GA4_PLAN_REGISTRY["channel"]
    if "campaign" in normalized:
        return GA4_PLAN_REGISTRY["campaign"]
    if "country" in normalized or "geo" in normalized or "geography" in normalized:
        return GA4_PLAN_REGISTRY["geography"]
    if "device" in normalized or "mobile" in normalized or "desktop" in normalized:
        return GA4_PLAN_REGISTRY["device"]

    return GA4_PLAN_REGISTRY["traffic_trend"]


def _plan_for_query(query: str) -> GA4Plan:
    if not settings.openai_api_key:
        return _fallback_plan_for_query(query)

    try:
        client = openai.OpenAI(api_key=settings.openai_api_key)
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            max_tokens=120,
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You classify Google Analytics questions into one safe allowlisted report plan. "
                        "Return JSON with keys plan_key and reasoning. "
                        "Allowed plan_key values: "
                        "top_pages, landing_pages, source_medium, channel, campaign, geography, device, traffic_trend. "
                        "Choose top_pages for questions about which pages were visited most, page popularity, home page performance, or page views. "
                        "Choose landing_pages only when the user explicitly asks about landing pages or entry pages. "
                        "Choose traffic_trend for generic trends over time. "
                        "Do not invent metrics or dimensions outside the allowlist."
                    ),
                },
                {"role": "user", "content": query},
            ],
        )
        payload = json.loads(response.choices[0].message.content or "{}")
        plan_key = str(payload.get("plan_key", "")).strip().lower()
        if plan_key in GA4_PLAN_REGISTRY:
            return GA4_PLAN_REGISTRY[plan_key]
    except Exception as exc:
        logger.debug("GA4 planner fallback triggered: %s", exc)

    return _fallback_plan_for_query(query)


def _get_client() -> BetaAnalyticsDataClient:
    key_path = os.path.expanduser(os.path.expandvars(settings.google_service_account_key_path))
    if not key_path:
        raise ValueError("Google service account key path is not configured")
    if not os.path.exists(key_path):
        raise ValueError("Google service account key file was not found on the backend")

    credentials = service_account.Credentials.from_service_account_file(
        key_path,
        scopes=[GA4_READONLY_SCOPE],
    )
    return BetaAnalyticsDataClient(credentials=credentials)


def _format_dimension_value(dimension_name: str, value: str) -> str:
    if dimension_name == "date" and len(value) == 8 and value.isdigit():
        return f"{value[0:4]}-{value[4:6]}-{value[6:8]}"
    return value or "(not set)"


def _format_int(value: str) -> str:
    try:
        return f"{int(float(value)):,}"
    except Exception:
        return value


def _series_payload(metric_names: list[str]) -> list[dict]:
    return [{"key": metric_name, "label": metric_name} for metric_name in metric_names]


def _dashboard_visualizations(
    *,
    plan: GA4Plan,
    company_name: str,
    property_id: str,
    label: str,
    dimension_name: str,
    metric_names: list[str],
    rows: list[dict],
) -> list[dict]:
    base_meta = {
        "company_name": company_name,
        "source_mode": "google_analytics",
        "date_range": label,
        "property_id": property_id,
    }
    visualizations = [
        {
            "type": plan.visualization_type,
            "title": plan.title,
            "subtitle": f"{company_name} | {label}",
            "x_key": dimension_name,
            "series": _series_payload(metric_names),
            "rows": rows,
            "meta": base_meta,
        }
    ]

    if rows:
        primary_metric = plan.order_metric
        primary_rows = [
            {
                dimension_name: row.get(dimension_name),
                primary_metric: row.get(primary_metric),
            }
            for row in rows
        ]
        visualizations.append(
            {
                "type": "bar",
                "title": f"{primary_metric.replace('_', ' ').title()} focus",
                "subtitle": f"{company_name} | {label}",
                "x_key": dimension_name,
                "series": [{"key": primary_metric, "label": primary_metric}],
                "rows": primary_rows[:8],
                "meta": base_meta,
            }
        )

        if len(metric_names) > 1:
            companion_metric = metric_names[1]
            companion_rows = [
                {
                    dimension_name: row.get(dimension_name),
                    companion_metric: row.get(companion_metric),
                }
                for row in rows
            ]
            visualizations.append(
                {
                    "type": "bar",
                    "title": f"{companion_metric.replace('_', ' ').title()} comparison",
                    "subtitle": f"{company_name} | {label}",
                    "x_key": dimension_name,
                    "series": [{"key": companion_metric, "label": companion_metric}],
                    "rows": companion_rows[:8],
                    "meta": base_meta,
                }
            )

        visualizations.append(
            {
                "type": "table",
                "title": "Underlying data",
                "subtitle": f"{company_name} | {label}",
                "x_key": dimension_name,
                "series": _series_payload(metric_names),
                "rows": rows,
                "meta": base_meta,
            }
        )

    return visualizations


def generate_ga4_answer(query: str, company: Company) -> AnswerResponse:
    if not company.ga4_property_id:
        return AnswerResponse(
            text=(
                f"Google Analytics is selected for **{company.name}**, but no GA4 property ID is configured yet."
            ),
            warnings=["Missing GA4 property ID for the selected company."],
        )

    plan = _plan_for_query(query)
    start_date, end_date, label = _parse_date_range(query)
    try:
        client = _get_client()
        response = client.run_report(
            RunReportRequest(
                property=f"properties/{company.ga4_property_id}",
                date_ranges=[DateRange(start_date=start_date, end_date=end_date)],
                dimensions=[Dimension(name=name) for name in plan.dimensions],
                metrics=[Metric(name=name) for name in plan.metrics],
                order_bys=[
                    OrderBy(
                        metric=OrderBy.MetricOrderBy(metric_name=plan.order_metric),
                        desc=plan.dimensions[0] != "date",
                    )
                ],
                limit=plan.limit,
            )
        )
    except Exception as exc:
        return AnswerResponse(
            text=f"I could not query Google Analytics for **{company.name}** right now.",
            warnings=[str(exc)],
            sections=[AnswerSection(type="explanation", content="Google Analytics query failed.", grounded=False)],
        )

    if not response.rows:
        return AnswerResponse(
            text=f"I connected to Google Analytics for **{company.name}**, but no rows were returned for {label}.",
            warnings=["The report returned no data."],
            sections=[AnswerSection(type="explanation", content="No data returned.", grounded=False)],
        )

    metric_names = [metric.name for metric in response.metric_headers]
    dimension_name = response.dimension_headers[0].name if response.dimension_headers else "label"

    totals = {name: 0.0 for name in metric_names}
    for row in response.rows:
        for metric_name, metric_value in zip(metric_names, row.metric_values):
            try:
                totals[metric_name] += float(metric_value.value or 0)
            except Exception:
                pass

    viz_rows: list[dict] = []
    summary_rows: list[dict] = []
    for index, row in enumerate(response.rows, start=1):
        dim_value = _format_dimension_value(
            dimension_name,
            row.dimension_values[0].value if row.dimension_values else "",
        )
        payload_row = {dimension_name: dim_value}
        summary_metrics: dict[str, str] = {}
        for metric_name, metric_value in zip(metric_names, row.metric_values):
            try:
                payload_row[metric_name] = int(float(metric_value.value or 0))
            except Exception:
                payload_row[metric_name] = metric_value.value
            summary_metrics[_series_payload([metric_name])[0]["label"]] = _format_int(metric_value.value)
        viz_rows.append(payload_row)
        if index <= 5:
            summary_rows.append({"label": dim_value, "metrics": summary_metrics})

    totals_display = {
        metric_name: _format_int(str(totals[metric_name]))
        for metric_name in metric_names
    }
    text = build_marketing_narrative(
        source_name="Google Analytics",
        report_title=plan.title,
        company_name=company.name,
        date_range=label,
        user_query=query,
        primary_metric_key=plan.order_metric,
        totals_display=totals_display,
        top_rows=summary_rows,
    )

    visualizations = _dashboard_visualizations(
        plan=plan,
        company_name=company.name,
        property_id=company.ga4_property_id,
        label=label,
        dimension_name=dimension_name,
        metric_names=metric_names,
        rows=viz_rows,
    )
    visualizations = build_dashboard_visualizations_with_llm(
        source_name="Google Analytics",
        source_mode="google_analytics",
        report_title=plan.title,
        company_name=company.name,
        date_range=label,
        user_query=query,
        x_key=dimension_name,
        metric_keys=metric_names,
        rows=viz_rows,
        base_meta={
            "company_name": company.name,
            "source_mode": "google_analytics",
            "date_range": label,
            "property_id": company.ga4_property_id,
        },
        fallback_visualizations=visualizations,
    )

    return AnswerResponse(
        text=text,
        sections=[AnswerSection(type="explanation", content=text, grounded=False)],
        visualizations=visualizations,
    )
