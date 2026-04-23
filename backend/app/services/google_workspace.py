import os
import re
from datetime import datetime, timezone
from typing import Any

import httpx
from google.auth.transport.requests import Request
from google.oauth2 import service_account

from app.core.config import settings

GOOGLE_WORKSPACE_SCOPES = [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/spreadsheets",
]

DOCS_MIME_TYPE = "application/vnd.google-apps.document"
SHEETS_MIME_TYPE = "application/vnd.google-apps.spreadsheet"


def _service_account_key_path() -> str:
    key_path = os.path.expanduser(os.path.expandvars(settings.google_service_account_key_path))
    if not key_path:
        raise ValueError("Google service account key path is not configured")
    if not os.path.exists(key_path):
        raise ValueError("Google service account key file was not found on the backend")
    return key_path


def _get_access_token() -> str:
    credentials = service_account.Credentials.from_service_account_file(
        _service_account_key_path(),
        scopes=GOOGLE_WORKSPACE_SCOPES,
    )
    credentials.refresh(Request())
    if not credentials.token:
        raise ValueError("Failed to obtain Google Workspace access token")
    return credentials.token


def _google_headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {_get_access_token()}",
        "Content-Type": "application/json",
    }


def parse_google_destination_url(url: str) -> tuple[str, str]:
    normalized = (url or "").strip()
    docs_match = re.search(r"docs\.google\.com/document(?:/u/\d+)?/d/([a-zA-Z0-9_-]+)", normalized)
    if docs_match:
        return "google_doc", docs_match.group(1)

    sheets_match = re.search(r"docs\.google\.com/spreadsheets(?:/u/\d+)?/d/([a-zA-Z0-9_-]+)", normalized)
    if sheets_match:
        return "google_sheet", sheets_match.group(1)

    raise ValueError("Provide a valid Google Docs or Google Sheets link")


def _drive_get_file(file_id: str) -> dict[str, Any]:
    response = httpx.get(
        f"https://www.googleapis.com/drive/v3/files/{file_id}",
        headers=_google_headers(),
        params={"fields": "id,name,mimeType,capabilities(canEdit)"},
        timeout=30.0,
    )
    if response.is_error:
        raise ValueError(
            "Maia could not access that Google file. Share it with the Maia service email and grant edit access."
        )
    return response.json()


def verify_google_destination(url: str) -> dict[str, Any]:
    destination_type, file_id = parse_google_destination_url(url)
    file_info = _drive_get_file(file_id)
    expected_mime = DOCS_MIME_TYPE if destination_type == "google_doc" else SHEETS_MIME_TYPE
    if file_info.get("mimeType") != expected_mime:
        raise ValueError("The provided link does not match the selected Google file type")
    if not file_info.get("capabilities", {}).get("canEdit", False):
        raise ValueError("Maia can read the file but cannot edit it. Grant editor access to the service email.")
    return {
        "type": destination_type,
        "file_id": file_id,
        "title": file_info.get("name") or "Untitled",
        "status": "verified",
        "last_verified_at": datetime.now(timezone.utc),
    }


def _strip_markdown(text: str) -> str:
    cleaned = text or ""
    cleaned = re.sub(r"`([^`]+)`", r"\1", cleaned)
    cleaned = re.sub(r"\*\*([^*]+)\*\*", r"\1", cleaned)
    cleaned = re.sub(r"\*([^*]+)\*", r"\1", cleaned)
    cleaned = re.sub(r"^#{1,6}\s*", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _visualization_rows_to_text(visualization: dict[str, Any], max_rows: int = 8) -> str:
    rows = visualization.get("rows") or []
    if not rows:
        return ""
    headers = list(rows[0].keys())
    lines = [
        visualization.get("title") or "Data table",
        "\t".join(headers),
    ]
    for row in rows[:max_rows]:
        lines.append("\t".join(str(row.get(header, "")) for header in headers))
    return "\n".join(lines)


def _build_docs_report_text(
    *,
    title: str,
    content: str,
    visualizations: list[dict[str, Any]],
    company_name: str | None,
    search_mode: str | None,
) -> str:
    metadata_lines = [f"Report: {title}", f"Generated: {datetime.now(timezone.utc).isoformat()}"]
    if company_name:
        metadata_lines.append(f"Company: {company_name}")
    if search_mode:
        metadata_lines.append(f"Source: {search_mode}")

    sections = [
        "\n\n" + "\n".join(metadata_lines),
        "",
        _strip_markdown(content),
    ]

    if visualizations:
        sections.append("")
        sections.append("Tables")
        for visualization in visualizations:
            table_text = _visualization_rows_to_text(visualization)
            if table_text:
                sections.extend(["", table_text])

    return "\n".join(sections).strip() + "\n"


def append_report_to_google_doc(
    *,
    document_id: str,
    title: str,
    content: str,
    visualizations: list[dict[str, Any]],
    company_name: str | None,
    search_mode: str | None,
) -> None:
    document_response = httpx.get(
        f"https://docs.googleapis.com/v1/documents/{document_id}",
        headers=_google_headers(),
        timeout=30.0,
    )
    if document_response.is_error:
        raise ValueError("Unable to open the Google Doc for writing")

    document = document_response.json()
    end_index = 1
    body_content = document.get("body", {}).get("content", [])
    if body_content:
        end_index = max(int(item.get("endIndex", 1)) for item in body_content) - 1

    report_text = _build_docs_report_text(
        title=title,
        content=content,
        visualizations=visualizations,
        company_name=company_name,
        search_mode=search_mode,
    )

    response = httpx.post(
        f"https://docs.googleapis.com/v1/documents/{document_id}:batchUpdate",
        headers=_google_headers(),
        json={
            "requests": [
                {
                    "insertText": {
                        "location": {"index": max(end_index, 1)},
                        "text": report_text,
                    }
                }
            ]
        },
        timeout=30.0,
    )
    if response.is_error:
        raise ValueError("Unable to write the report into the Google Doc")


def _sheet_title(base_title: str) -> str:
    compact = re.sub(r"[\\/*?:\[\]]", " ", base_title or "Maia Export")
    compact = " ".join(compact.split()).strip()
    timestamp = datetime.now(timezone.utc).strftime("%m%d %H%M")
    return f"{compact[:72]} {timestamp}".strip()[:100]


def _build_sheet_rows(
    *,
    title: str,
    content: str,
    visualizations: list[dict[str, Any]],
    company_name: str | None,
    search_mode: str | None,
) -> tuple[list[list[Any]], list[dict[str, Any]]]:
    rows: list[list[Any]] = [
        [title],
        ["Generated", datetime.now(timezone.utc).isoformat()],
    ]
    if company_name:
        rows.append(["Company", company_name])
    if search_mode:
        rows.append(["Source", search_mode])

    rows.extend([[], ["Narrative"], [_strip_markdown(content)]])

    chart_specs: list[dict[str, Any]] = []
    current_row = len(rows)
    for visualization in visualizations:
        data_rows = visualization.get("rows") or []
        if not data_rows:
            continue
        headers = list(data_rows[0].keys())
        rows.extend([[], [visualization.get("title") or "Visualization"], headers])
        header_row_index = len(rows) - 1
        for row in data_rows:
            rows.append([row.get(header, "") for header in headers])

        x_key = visualization.get("x_key")
        series = visualization.get("series") or []
        if x_key and series:
            try:
                domain_col = headers.index(x_key)
                metric_col = headers.index(series[0]["key"])
                chart_specs.append(
                    {
                        "type": visualization.get("type") or "bar",
                        "title": visualization.get("title") or "Chart",
                        "header_row_index": header_row_index,
                        "data_start_row_index": header_row_index + 1,
                        "data_end_row_index": header_row_index + 1 + len(data_rows),
                        "domain_col": domain_col,
                        "metric_col": metric_col,
                        "anchor_col": max(len(headers) + 2, 6),
                    }
                )
            except ValueError:
                pass

        current_row = len(rows)

    return rows, chart_specs


def write_report_to_google_sheet(
    *,
    spreadsheet_id: str,
    title: str,
    content: str,
    visualizations: list[dict[str, Any]],
    company_name: str | None,
    search_mode: str | None,
) -> None:
    sheet_title = _sheet_title(title)
    create_response = httpx.post(
        f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}:batchUpdate",
        headers=_google_headers(),
        json={
            "requests": [
                {
                    "addSheet": {
                        "properties": {
                            "title": sheet_title,
                            "gridProperties": {"rowCount": 200, "columnCount": 20},
                        }
                    }
                }
            ],
            "includeSpreadsheetInResponse": False,
        },
        timeout=30.0,
    )
    if create_response.is_error:
        raise ValueError("Unable to create a report tab in the Google Sheet")

    replies = create_response.json().get("replies", [])
    sheet_id = replies[0]["addSheet"]["properties"]["sheetId"]
    rows, chart_specs = _build_sheet_rows(
        title=title,
        content=content,
        visualizations=visualizations,
        company_name=company_name,
        search_mode=search_mode,
    )

    values_response = httpx.put(
        f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{sheet_title}!A1",
        headers=_google_headers(),
        params={"valueInputOption": "RAW"},
        json={"range": f"{sheet_title}!A1", "majorDimension": "ROWS", "values": rows},
        timeout=30.0,
    )
    if values_response.is_error:
        raise ValueError("Unable to write the report rows into the Google Sheet")

    chart_requests = []
    for chart in chart_specs:
        chart_type = "LINE" if chart["type"] == "line" else "COLUMN"
        chart_requests.append(
            {
                "addChart": {
                    "chart": {
                        "spec": {
                            "title": chart["title"],
                            "basicChart": {
                                "chartType": chart_type,
                                "legendPosition": "BOTTOM_LEGEND",
                                "axis": [
                                    {"position": "BOTTOM_AXIS", "title": "Dimension"},
                                    {"position": "LEFT_AXIS", "title": "Value"},
                                ],
                                "domains": [
                                    {
                                        "domain": {
                                            "sourceRange": {
                                                "sources": [
                                                    {
                                                        "sheetId": sheet_id,
                                                        "startRowIndex": chart["data_start_row_index"],
                                                        "endRowIndex": chart["data_end_row_index"],
                                                        "startColumnIndex": chart["domain_col"],
                                                        "endColumnIndex": chart["domain_col"] + 1,
                                                    }
                                                ]
                                            }
                                        }
                                    }
                                ],
                                "series": [
                                    {
                                        "series": {
                                            "sourceRange": {
                                                "sources": [
                                                    {
                                                        "sheetId": sheet_id,
                                                        "startRowIndex": chart["data_start_row_index"],
                                                        "endRowIndex": chart["data_end_row_index"],
                                                        "startColumnIndex": chart["metric_col"],
                                                        "endColumnIndex": chart["metric_col"] + 1,
                                                    }
                                                ]
                                            }
                                        },
                                        "targetAxis": "LEFT_AXIS",
                                    }
                                ],
                            },
                        },
                        "position": {
                            "overlayPosition": {
                                "anchorCell": {
                                    "sheetId": sheet_id,
                                    "rowIndex": chart["header_row_index"],
                                    "columnIndex": chart["anchor_col"],
                                },
                                "widthPixels": 640,
                                "heightPixels": 360,
                            }
                        },
                    }
                }
            }
        )

    if chart_requests:
        charts_response = httpx.post(
            f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}:batchUpdate",
            headers=_google_headers(),
            json={"requests": chart_requests},
            timeout=30.0,
        )
        if charts_response.is_error:
            raise ValueError("The sheet data was written, but Maia could not create the charts")
