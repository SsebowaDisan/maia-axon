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
                f"Overall, {source_name} returned " + ", ".join(total_parts) + ".",
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
                        "Answer the user's actual question first in plain language. "
                        "Write polished Markdown with natural structure instead of a rigid template. "
                        "Choose the most relevant returned metrics from the payload instead of assuming fixed labels. "
                        "A short heading is allowed if it helps, but do not force repeated boilerplate sections. "
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
