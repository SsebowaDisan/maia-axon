import json
import logging
import re
from typing import Any

import openai

from app.core.config import settings

logger = logging.getLogger(__name__)


def _humanize_key(value: str) -> str:
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", value.replace("_", " "))
    return " ".join(part for part in spaced.split() if part).strip().title()


def _normalize_totals_display(totals_display: dict[str, str]) -> dict[str, str]:
    return {_humanize_key(metric): value for metric, value in totals_display.items()}


def _normalize_top_rows(top_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized_rows: list[dict[str, Any]] = []
    for row in top_rows:
        metrics = row.get("metrics", {})
        normalized_rows.append(
            {
                "label": row.get("label"),
                "metrics": {_humanize_key(metric): value for metric, value in metrics.items()},
            }
        )
    return normalized_rows


def _fallback_summary(
    *,
    report_title: str,
    source_name: str,
    company_name: str,
    date_range: str,
    primary_metric_label: str,
    totals_display: dict[str, str],
    top_rows: list[dict[str, Any]],
) -> str:
    totals_display = _normalize_totals_display(totals_display)
    top_rows = _normalize_top_rows(top_rows)

    if not top_rows:
        return (
            f"## {report_title}\n\n"
            f"I connected to {source_name} for **{company_name}**, but there was not enough data to summarize {date_range}."
        )

    top_row = top_rows[0]
    top_label = str(top_row.get("label") or "(not set)")
    top_metrics = top_row.get("metrics", {})
    top_primary_value = top_metrics.get(primary_metric_label)
    if top_primary_value is None and top_metrics:
        top_primary_value = next(iter(top_metrics.values()))
    top_primary_value = top_primary_value or "0"

    summary_lines = [
        f"## {report_title}",
        "",
        (
            f"The strongest result for **{company_name}** over **{date_range}** was **{top_label}**, "
            f"with **{top_primary_value} {primary_metric_label.lower()}**."
        ),
    ]

    total_parts = [
        f"**{metric.lower()}**: {value}"
        for metric, value in list(totals_display.items())[:4]
    ]
    if total_parts:
        summary_lines.extend(
            [
                "",
                "### Key metrics",
                "- " + "\n- ".join(total_parts),
            ]
        )

    runners_up = top_rows[1:3]
    if runners_up:
        runner_parts = []
        for row in runners_up:
            row_label = str(row.get("label") or "(not set)")
            row_metrics = row.get("metrics", {})
            row_primary_value = row_metrics.get(primary_metric_label)
            if row_primary_value is None and row_metrics:
                row_primary_value = next(iter(row_metrics.values()))
            row_primary_value = row_primary_value or "0"
            runner_parts.append(f"**{row_label}** ({row_primary_value})")
        summary_lines.extend(
            [
                "",
                "### What stands out",
                "The next strongest results were " + " and ".join(runner_parts) + ".",
            ]
        )

    return "\n".join(summary_lines)


def build_marketing_narrative(
    *,
    source_name: str,
    report_title: str,
    company_name: str,
    date_range: str,
    user_query: str,
    primary_metric_key: str,
    totals_display: dict[str, str],
    top_rows: list[dict[str, Any]],
) -> str:
    primary_metric_label = _humanize_key(primary_metric_key)
    normalized_totals = _normalize_totals_display(totals_display)
    normalized_rows = _normalize_top_rows(top_rows)
    payload = {
        "source_name": source_name,
        "report_title": report_title,
        "company_name": company_name,
        "date_range": date_range,
        "user_query": user_query,
        "primary_metric_label": primary_metric_label,
        "totals": normalized_totals,
        "top_rows": normalized_rows[:5],
    }

    if not settings.openai_api_key:
        return _fallback_summary(
            report_title=report_title,
            source_name=source_name,
            company_name=company_name,
            date_range=date_range,
            primary_metric_label=primary_metric_label,
            totals_display=totals_display,
            top_rows=top_rows,
        )

    try:
        client = openai.OpenAI(api_key=settings.openai_api_key)
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            max_tokens=280,
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You write concise analytics summaries for a dashboard. "
                        "Use only the supplied data. Never invent numbers, trends, pages, campaigns, or explanations. "
                        "Use this order for both Google Analytics and Google Ads reports: "
                        "1) answer the user's actual question first in one or two plain-language sentences; "
                        "2) include a compact 'Key metrics' section using the most relevant totals; "
                        "3) include a short 'What stands out' interpretation based only on returned rows; "
                        "4) include 'Next actions' only when the data supports concrete actions. "
                        "Do not describe the dashboard or charts; the UI renders them after your summary. "
                        "Write polished Markdown with natural structure. "
                        "Choose the most relevant returned metrics from the payload instead of assuming fixed labels. "
                        "Keep it readable for a business user. "
                        "Mention the top result and the main takeaway. "
                        "If the data is ranked, mention the leading item and one or two runners-up when useful. "
                        "Return JSON with one key: markdown."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(payload),
                },
            ],
        )
        content = response.choices[0].message.content or "{}"
        markdown = str(json.loads(content).get("markdown", "")).strip()
        if markdown:
            return markdown
    except Exception as exc:
        logger.debug("Marketing narrative fallback triggered: %s", exc)

    return _fallback_summary(
        report_title=report_title,
        source_name=source_name,
        company_name=company_name,
        date_range=date_range,
        primary_metric_label=primary_metric_label,
        totals_display=normalized_totals,
        top_rows=normalized_rows,
    )


def build_dashboard_visualizations_with_llm(
    *,
    source_name: str,
    source_mode: str,
    report_title: str,
    company_name: str,
    date_range: str,
    user_query: str,
    x_key: str,
    metric_keys: list[str],
    rows: list[dict[str, Any]],
    base_meta: dict[str, Any],
    fallback_visualizations: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Let the LLM choose chart composition while keeping data and schema guarded."""
    if not rows or not metric_keys or not settings.openai_api_key:
        return fallback_visualizations

    allowed_types = {"line", "area", "bar", "stacked_bar", "pie"}
    row_sample = rows[:12]
    payload = {
        "source_name": source_name,
        "source_mode": source_mode,
        "report_title": report_title,
        "company_name": company_name,
        "date_range": date_range,
        "user_query": user_query,
        "x_key": x_key,
        "available_metric_keys": metric_keys,
        "row_sample": row_sample,
        "rules": {
            "allowed_types": sorted(allowed_types),
            "max_visualizations": 4,
            "series_keys_must_come_from_available_metric_keys": True,
            "x_key_must_equal": x_key,
        },
    }

    try:
        client = openai.OpenAI(api_key=settings.openai_api_key)
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            max_tokens=700,
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are Maia's analytics dashboard designer for Google Analytics and Google Ads reports. "
                        "Choose the best dashboard structure for the user's exact business question using only the provided rows and metric keys. "
                        "Do not create API queries, do not invent metrics, and do not invent rows. "
                        "Return JSON with key visualizations. "
                        "Each visualization must have: type, title, subtitle, series_keys, optional row_limit. "
                        "Allowed types are line, area, bar, stacked_bar, pie. "
                        "Use line or area for time trends, bar for ranked comparisons, stacked_bar only for meaningful composition, and pie only for fewer than 6 categories. "
                        "Prefer one large primary visual plus one to three supporting visuals. "
                        "For Google Ads, consider spend/cost, clicks, conversions, CTR, CPC, conversion value, and campaign/device/date context when available. "
                        "For GA4, consider sessions, active users, page views, geography, source, device, campaign, or page context when available. "
                        "Make titles business-readable and specific to the question."
                    ),
                },
                {"role": "user", "content": json.dumps(payload)},
            ],
        )
        content = response.choices[0].message.content or "{}"
        requested = json.loads(content).get("visualizations", [])
    except Exception as exc:
        logger.debug("Dashboard LLM fallback triggered: %s", exc)
        return fallback_visualizations

    if not isinstance(requested, list):
        return fallback_visualizations

    visualizations: list[dict[str, Any]] = []
    for item in requested[:4]:
        if not isinstance(item, dict):
            continue

        chart_type = str(item.get("type", "")).strip()
        if chart_type not in allowed_types:
            continue

        series_keys = item.get("series_keys", [])
        if not isinstance(series_keys, list):
            continue

        clean_series_keys = [
            str(key)
            for key in series_keys
            if isinstance(key, str) and key in metric_keys
        ]
        if not clean_series_keys:
            continue

        if chart_type == "pie" and len(rows) > 6:
            chart_type = "bar"

        try:
            row_limit = int(item.get("row_limit") or (6 if chart_type == "pie" else 10))
        except Exception:
            row_limit = 10
        row_limit = max(3, min(row_limit, 20))

        title = str(item.get("title") or report_title).strip()[:120]
        subtitle = str(item.get("subtitle") or f"{company_name} | {date_range}").strip()[:180]
        selected_rows = [
            {
                x_key: row.get(x_key),
                **{metric_key: row.get(metric_key) for metric_key in clean_series_keys},
            }
            for row in rows[:row_limit]
        ]

        visualizations.append(
            {
                "type": chart_type,
                "title": title,
                "subtitle": subtitle,
                "x_key": x_key,
                "series": [
                    {"key": metric_key, "label": _humanize_key(metric_key)}
                    for metric_key in clean_series_keys
                ],
                "rows": selected_rows,
                "meta": {
                    **base_meta,
                    "dashboard_designed_by": "llm",
                    "dashboard_question": user_query,
                },
            }
        )

    if not visualizations:
        return fallback_visualizations

    visualizations.append(
        {
            "type": "table",
            "title": "Underlying data",
            "subtitle": f"{company_name} | {date_range}",
            "x_key": x_key,
            "series": [{"key": metric_key, "label": _humanize_key(metric_key)} for metric_key in metric_keys],
            "rows": rows,
            "meta": {
                **base_meta,
                "dashboard_designed_by": "llm",
                "dashboard_question": user_query,
            },
        }
    )
    return visualizations
