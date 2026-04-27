import calendar
import re
from datetime import date, timedelta


MONTHS = {name.lower(): index for index, name in enumerate(calendar.month_name) if name}
MONTHS.update({name.lower(): index for index, name in enumerate(calendar.month_abbr) if name})

NUMBER_WORDS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
}


def _month_end(year: int, month: int) -> date:
    return date(year, month, calendar.monthrange(year, month)[1])


def _month_label(year: int, month: int, include_year: bool) -> str:
    label = calendar.month_name[month]
    return f"{label} {year}" if include_year else label


def _parse_iso_date(value: str) -> date | None:
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def _parse_month_day(value: str, *, default_year: int) -> date | None:
    value = value.strip().lower().replace(",", "")
    iso = _parse_iso_date(value)
    if iso:
        return iso

    match = re.fullmatch(
        r"(?P<month>[a-z]+)\s+(?P<day>\d{1,2})(?:\s+(?P<year>\d{4}))?",
        value,
    )
    if not match:
        return None

    month = MONTHS.get(match.group("month"))
    if not month:
        return None
    year = int(match.group("year") or default_year)
    day = int(match.group("day"))
    try:
        return date(year, month, day)
    except ValueError:
        return None


def parse_date_range(query: str, *, today: date | None = None) -> tuple[str, str, str]:
    normalized = query.lower()
    today = today or date.today()

    if "today" in normalized:
        return today.isoformat(), today.isoformat(), "today"
    if "yesterday" in normalized:
        day = today - timedelta(days=1)
        return day.isoformat(), day.isoformat(), "yesterday"

    explicit_from_to = re.search(
        r"\bfrom\s+([a-z]+\s+\d{1,2}(?:,?\s+\d{4})?|\d{4}-\d{2}-\d{2})\s+"
        r"(?:to|through|until|-)\s+([a-z]+\s+\d{1,2}(?:,?\s+\d{4})?|\d{4}-\d{2}-\d{2})",
        normalized,
    )
    if explicit_from_to:
        start = _parse_month_day(explicit_from_to.group(1), default_year=today.year)
        end = _parse_month_day(explicit_from_to.group(2), default_year=start.year if start else today.year)
        if start and end:
            if end < start and not re.search(r"\d{4}", explicit_from_to.group(2)):
                end = date(end.year + 1, end.month, end.day)
            return start.isoformat(), end.isoformat(), f"{start.isoformat()} to {end.isoformat()}"

    explicit_days = re.search(r"last\s+(\d{1,3})\s+days?", normalized)
    if explicit_days:
        days = int(explicit_days.group(1))
        start = today - timedelta(days=max(days - 1, 0))
        return start.isoformat(), today.isoformat(), f"last {days} days"

    explicit_months = re.search(r"last\s+(\d{1,2})\s+months?", normalized)
    if explicit_months:
        months = int(explicit_months.group(1))
        days = max(months * 30, 1)
        start = today - timedelta(days=days - 1)
        return start.isoformat(), today.isoformat(), f"last {months} months"

    for word, months in NUMBER_WORDS.items():
        if f"last {word} month" in normalized or f"last {word} months" in normalized:
            days = months * 30
            start = today - timedelta(days=days - 1)
            return start.isoformat(), today.isoformat(), f"last {months} months"

    if "this week" in normalized:
        start = today - timedelta(days=today.weekday())
        return start.isoformat(), today.isoformat(), "this week"
    if "this month" in normalized:
        start = today.replace(day=1)
        return start.isoformat(), today.isoformat(), "this month"

    if "last week" in normalized:
        start = today - timedelta(days=6)
        return start.isoformat(), today.isoformat(), "last 7 days"
    if "last month" in normalized:
        start = today - timedelta(days=29)
        return start.isoformat(), today.isoformat(), "last 30 days"
    if "last quarter" in normalized:
        start = today - timedelta(days=89)
        return start.isoformat(), today.isoformat(), "last 90 days"

    month_match = re.search(
        r"\b("
        + "|".join(sorted(MONTHS.keys(), key=len, reverse=True))
        + r")\b(?:\s+(\d{4}))?",
        normalized,
    )
    if month_match:
        month = MONTHS[month_match.group(1)]
        explicit_year = month_match.group(2)
        year = int(explicit_year) if explicit_year else today.year
        if not explicit_year and month > today.month:
            year -= 1
        start = date(year, month, 1)
        end = min(_month_end(year, month), today) if year == today.year and month == today.month else _month_end(year, month)
        return start.isoformat(), end.isoformat(), _month_label(year, month, include_year=bool(explicit_year))

    start = today - timedelta(days=29)
    return start.isoformat(), today.isoformat(), "last 30 days"
