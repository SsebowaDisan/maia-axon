import os
import re
from dataclasses import dataclass

from google.analytics.data_v1beta import BetaAnalyticsDataClient
from google.analytics.data_v1beta.types import DateRange, Dimension, Metric, OrderBy, RunReportRequest
from google.oauth2 import service_account

from app.models.company import Company
from app.services.answer_engine import AnswerResponse, AnswerSection

GA4_READONLY_SCOPE = "https://www.googleapis.com/auth/analytics.readonly"


@dataclass
class GA4Plan:
    title: str
    dimensions: list[str]
    metrics: list[str]
    order_metric: str
    visualization_type: str
    limit: int = 10


def _parse_date_range(query: str) -> tuple[str, str, str]:
    normalized = query.lower()
    if "today" in normalized:
        return "today", "today", "today"
    if "yesterday" in normalized:
        return "yesterday", "yesterday", "yesterday"

    explicit = re.search(r"last\s+(\d{1,3})\s+days?", normalized)
    if explicit:
        days = explicit.group(1)
        return f"{days}daysAgo", "today", f"last {days} days"

    if "last week" in normalized:
        return "7daysAgo", "today", "last 7 days"
    if "last quarter" in normalized:
        return "90daysAgo", "today", "last 90 days"
    if "last month" in normalized:
        return "30daysAgo", "today", "last 30 days"
    if "this month" in normalized:
        return "30daysAgo", "today", "this month"

    return "30daysAgo", "today", "last 30 days"


def _plan_for_query(query: str) -> GA4Plan:
    normalized = query.lower()

    if "landing" in normalized or "top page" in normalized or "landing page" in normalized:
        return GA4Plan(
            title="Top landing pages",
            dimensions=["landingPagePlusQueryString"],
            metrics=["sessions", "activeUsers", "screenPageViews"],
            order_metric="sessions",
            visualization_type="bar",
        )
    if "source" in normalized or "medium" in normalized:
        return GA4Plan(
            title="Source / medium performance",
            dimensions=["sessionSourceMedium"],
            metrics=["sessions", "activeUsers", "screenPageViews"],
            order_metric="sessions",
            visualization_type="bar",
        )
    if "channel" in normalized:
        return GA4Plan(
            title="Channel performance",
            dimensions=["sessionPrimaryChannelGroup"],
            metrics=["sessions", "activeUsers", "screenPageViews"],
            order_metric="sessions",
            visualization_type="bar",
        )
    if "campaign" in normalized:
        return GA4Plan(
            title="Campaign performance",
            dimensions=["sessionCampaignName"],
            metrics=["sessions", "activeUsers", "screenPageViews"],
            order_metric="sessions",
            visualization_type="bar",
        )
    if "country" in normalized or "geo" in normalized or "geography" in normalized:
        return GA4Plan(
            title="Geography breakdown",
            dimensions=["country"],
            metrics=["sessions", "activeUsers", "screenPageViews"],
            order_metric="sessions",
            visualization_type="bar",
        )
    if "device" in normalized or "mobile" in normalized or "desktop" in normalized:
        return GA4Plan(
            title="Device breakdown",
            dimensions=["deviceCategory"],
            metrics=["sessions", "activeUsers", "screenPageViews"],
            order_metric="sessions",
            visualization_type="bar",
        )

    return GA4Plan(
        title="Traffic trend",
        dimensions=["date"],
        metrics=["sessions", "activeUsers", "screenPageViews"],
        order_metric="sessions",
        visualization_type="line",
    )


def _get_client() -> BetaAnalyticsDataClient:
    from app.core.config import settings

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
            text=(
                f"I could not query Google Analytics for **{company.name}** right now."
            ),
            warnings=[str(exc)],
            sections=[AnswerSection(type="explanation", content="Google Analytics query failed.", grounded=False)],
        )

    if not response.rows:
        return AnswerResponse(
            text=(
                f"I connected to Google Analytics for **{company.name}**, but no rows were returned for {label}."
            ),
            warnings=["The report returned no data."],
            sections=[AnswerSection(type="explanation", content="No data returned.", grounded=False)],
        )

    first_metric_names = [metric.name for metric in response.metric_headers]
    dimension_name = response.dimension_headers[0].name if response.dimension_headers else ""

    totals = {name: 0.0 for name in first_metric_names}
    for row in response.rows:
        for metric_name, metric_value in zip(first_metric_names, row.metric_values):
            try:
                totals[metric_name] += float(metric_value.value or 0)
            except Exception:
                pass

    lines: list[str] = []
    viz_rows: list[dict] = []
    for index, row in enumerate(response.rows[: min(5, len(response.rows))], start=1):
        dim_value = _format_dimension_value(dimension_name, row.dimension_values[0].value if row.dimension_values else "")
        metric_parts = [
            f"{metric_name}: {_format_int(metric_value.value)}"
            for metric_name, metric_value in zip(first_metric_names, row.metric_values)
        ]
        lines.append(f"{index}. **{dim_value}** — " + ", ".join(metric_parts))

    for row in response.rows:
        dim_value = _format_dimension_value(dimension_name, row.dimension_values[0].value if row.dimension_values else "")
        payload_row = {dimension_name or "label": dim_value}
        for metric_name, metric_value in zip(first_metric_names, row.metric_values):
            try:
                payload_row[metric_name] = int(float(metric_value.value or 0))
            except Exception:
                payload_row[metric_name] = metric_value.value
        viz_rows.append(payload_row)

    summary_parts = []
    for metric_name in first_metric_names:
        summary_parts.append(f"**{metric_name}**: {_format_int(str(totals[metric_name]))}")

    text = (
        f"## {plan.title}\n\n"
        f"Google Analytics data for **{company.name}** over **{label}** using property **{company.ga4_property_id}**.\n\n"
        f"{', '.join(summary_parts)}\n\n"
        f"### Top rows\n"
        + "\n".join(f"- {line}" for line in lines)
    )

    visualizations = [
        {
            "type": plan.visualization_type,
            "title": plan.title,
            "subtitle": f"{company.name} · {label}",
            "x_key": dimension_name or "label",
            "series": [
                {"key": metric_name, "label": metric_name}
                for metric_name in first_metric_names
            ],
            "rows": viz_rows,
            "meta": {
                "company_name": company.name,
                "source_mode": "google_analytics",
                "date_range": label,
                "property_id": company.ga4_property_id,
            },
        }
    ]

    return AnswerResponse(
        text=text,
        sections=[AnswerSection(type="explanation", content=text, grounded=False)],
        visualizations=visualizations,
    )
