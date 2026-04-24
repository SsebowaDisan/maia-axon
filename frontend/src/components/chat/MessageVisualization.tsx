"use client";

import type { MessageVisualization, MessageVisualizationSeries } from "@/lib/types";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type DataRow = Record<string, string | number | null>;
type ChartSeries = MessageVisualizationSeries & { color: string };

const palette = ["#0f172a", "#2563eb", "#0f766e", "#ea580c", "#7c3aed", "#db2777"];

function defaultColor(index: number) {
  return palette[index % palette.length];
}

function toNumber(value: string | number | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function formatValue(value: string | number | null | undefined) {
  if (typeof value === "number") {
    return value.toLocaleString(undefined, {
      maximumFractionDigits: value % 1 === 0 ? 0 : 2,
    });
  }

  return value ?? "";
}

function formatMetricLabel(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function resolveSeries(visualization: MessageVisualization) {
  if (visualization.series?.length) {
    return visualization.series.map((series, index) => ({
      ...series,
      color: series.color || defaultColor(index),
    }));
  }

  const firstRow = visualization.rows?.[0];
  const xKey = visualization.x_key ?? "label";
  if (!firstRow) {
    return [];
  }

  return Object.keys(firstRow)
    .filter((key) => key !== xKey && toNumber(firstRow[key]) !== null)
    .map((key, index) => ({
      key,
      label: formatMetricLabel(key),
      color: defaultColor(index),
    }));
}

function buildOverviewCards(
  rows: DataRow[],
  xKey: string,
  series: ChartSeries[],
  type: MessageVisualization["type"],
) {
  const primary = series[0];
  const cards: Array<{ label: string; value: string; hint: string }> = [];

  for (const metric of series.slice(0, 3)) {
    const total = rows.reduce((sum, row) => sum + (toNumber(row[metric.key]) ?? 0), 0);
    cards.push({
      label: metric.label,
      value: formatValue(total),
      hint: "Total in view",
    });
  }

  if (!primary || !rows.length) {
    return cards;
  }

  const rankedRows = [...rows].sort(
    (left, right) => (toNumber(right[primary.key]) ?? 0) - (toNumber(left[primary.key]) ?? 0),
  );
  const topRow = rankedRows[0];
  if (topRow) {
    cards.push({
      label: "Top Segment",
      value: String(topRow[xKey] ?? "(not set)"),
      hint: `${primary.label} ${formatValue(toNumber(topRow[primary.key]) ?? 0)}`,
    });
  }

  if ((type === "line" || type === "area") && rows.length > 1) {
    const first = toNumber(rows[0]?.[primary.key]) ?? 0;
    const last = toNumber(rows.at(-1)?.[primary.key]) ?? 0;
    const delta = first === 0 ? null : ((last - first) / first) * 100;
    cards.push({
      label: "Trend",
      value:
        delta === null
          ? formatValue(last - first)
          : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`,
      hint: `${formatValue(first)} to ${formatValue(last)}`,
    });
  } else {
    const average =
      rows.reduce((sum, row) => sum + (toNumber(row[primary.key]) ?? 0), 0) / Math.max(rows.length, 1);
    cards.push({
      label: "Average",
      value: formatValue(average),
      hint: `Per ${formatMetricLabel(xKey)}`,
    });
  }

  return cards.slice(0, 4);
}

function buildContextBadges(visualization: MessageVisualization) {
  const meta = visualization.meta ?? {};
  const sourceMode = meta.source_mode;

  const badges: string[] = [];
  if (sourceMode === "google_analytics") {
    badges.push("Google Analytics");
  } else if (sourceMode === "google_ads") {
    badges.push("Google Ads");
  }

  if (typeof meta.company_name === "string" && meta.company_name) {
    badges.push(meta.company_name);
  }
  if (typeof meta.date_range === "string" && meta.date_range) {
    badges.push(meta.date_range);
  }
  if (typeof meta.property_id === "string" && meta.property_id) {
    badges.push(`Property ${meta.property_id}`);
  }
  if (typeof meta.customer_id === "string" && meta.customer_id) {
    badges.push(`Customer ${meta.customer_id}`);
  }

  return badges;
}

function compactXAxisLabel(value: string | number) {
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text.slice(5);
  }
  return text.length > 14 ? `${text.slice(0, 14)}...` : text;
}

function DashboardTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: string | number; color?: string }>;
  label?: string | number;
}) {
  if (!active || !payload?.length) {
    return null;
  }

  return (
    <div className="rounded-[20px] border border-black/[0.06] bg-white/96 px-4 py-3 shadow-[0_18px_36px_rgba(15,23,42,0.08)] backdrop-blur-xl">
      <p className="text-sm font-semibold text-ink">{label}</p>
      <div className="mt-2 space-y-1.5">
        {payload.map((item) => (
          <div key={`${item.name}-${item.value}`} className="flex items-center justify-between gap-4 text-xs">
            <span className="inline-flex items-center gap-2 text-muted">
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: item.color || defaultColor(0) }}
              />
              {item.name}
            </span>
            <span className="font-medium text-ink">{formatValue(item.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DashboardLegend({ series }: { series: ChartSeries[] }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {series.map((item) => (
        <span
          key={item.key}
          className="inline-flex items-center gap-2 rounded-full border border-black/[0.06] bg-white px-3 py-1.5 text-xs font-medium text-ink/80"
        >
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function TimeSeriesChart({
  visualization,
  series,
}: {
  visualization: MessageVisualization;
  series: ChartSeries[];
}) {
  const rows = visualization.rows ?? [];
  const xKey = visualization.x_key ?? "label";

  return (
    <div className="h-[420px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
          <defs>
            {series.map((item) => (
              <linearGradient key={item.key} id={`area-${item.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={item.color} stopOpacity={0.3} />
                <stop offset="100%" stopColor={item.color} stopOpacity={0.04} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke="rgba(17,17,17,0.08)" strokeDasharray="3 6" vertical={false} />
          <XAxis
            dataKey={xKey}
            tickFormatter={compactXAxisLabel}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "rgba(17,17,17,0.55)", fontSize: 11 }}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fill: "rgba(17,17,17,0.55)", fontSize: 11 }}
            tickFormatter={(value) => formatValue(value)}
            width={52}
          />
          <Tooltip content={<DashboardTooltip />} />
          <Legend content={() => <DashboardLegend series={series} />} />
          {series.map((item, index) => (
            <Area
              key={item.key}
              type="monotone"
              dataKey={item.key}
              name={item.label}
              stroke={item.color}
              fill={`url(#area-${item.key})`}
              strokeWidth={index === 0 ? 3 : 2.4}
              dot={{ r: 0 }}
              activeDot={{ r: 5, strokeWidth: 0, fill: item.color }}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function ComparisonChart({
  visualization,
  series,
}: {
  visualization: MessageVisualization;
  series: ChartSeries[];
}) {
  const rows = (visualization.rows ?? []).slice(0, 8);
  const xKey = visualization.x_key ?? "label";

  return (
    <div className="h-[420px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 8, right: 8, left: 8, bottom: 0 }}
          barCategoryGap={12}
        >
          <CartesianGrid stroke="rgba(17,17,17,0.06)" strokeDasharray="3 6" horizontal={false} />
          <XAxis
            type="number"
            axisLine={false}
            tickLine={false}
            tick={{ fill: "rgba(17,17,17,0.55)", fontSize: 11 }}
            tickFormatter={(value) => formatValue(value)}
          />
          <YAxis
            type="category"
            dataKey={xKey}
            width={240}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "rgba(17,17,17,0.76)", fontSize: 12 }}
            tickFormatter={compactXAxisLabel}
          />
          <Tooltip content={<DashboardTooltip />} />
          <Legend content={() => <DashboardLegend series={series} />} />
          {series.map((item, index) => (
            <Bar
              key={item.key}
              dataKey={item.key}
              name={item.label}
              fill={item.color}
              radius={index === 0 ? [10, 10, 10, 10] : [8, 8, 8, 8]}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function DistributionChart({
  visualization,
  series,
}: {
  visualization: MessageVisualization;
  series: ChartSeries[];
}) {
  const rows = visualization.rows ?? [];
  const xKey = visualization.x_key ?? "label";
  const primary = series[0];
  const pieRows = rows.slice(0, 6).map((row, index) => ({
    name: String(row[xKey] ?? "(not set)"),
    value: toNumber(row[primary?.key ?? "value"]) ?? 0,
    color: defaultColor(index),
  }));

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_320px]">
      <div className="h-[400px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip content={<DashboardTooltip />} />
            <Pie
              data={pieRows}
              dataKey="value"
              nameKey="name"
              innerRadius={68}
              outerRadius={110}
              paddingAngle={3}
              stroke="rgba(255,255,255,0.9)"
              strokeWidth={2}
            >
              {pieRows.map((entry) => (
                <Cell key={entry.name} fill={entry.color} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>

      <div className="space-y-3 self-center">
        {pieRows.map((row, index) => (
          <div
            key={row.name}
            className="rounded-[22px] border border-black/[0.06] bg-white/90 px-4 py-3"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">{row.name}</p>
                <p className="mt-1 text-xs text-muted">{primary?.label ?? "Value"}</p>
              </div>
              <div className="text-right">
                <span
                  className="inline-flex h-3 w-3 rounded-full"
                  style={{ backgroundColor: row.color }}
                />
                <p className="mt-2 text-sm font-semibold text-ink">{formatValue(row.value)}</p>
                <p className="text-[11px] uppercase tracking-[0.12em] text-muted">#{index + 1}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SnapshotPanel({
  rows,
  xKey,
  series,
}: {
  rows: DataRow[];
  xKey: string;
  series: ChartSeries[];
}) {
  return (
    <div className="rounded-[28px] border border-black/[0.06] bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(247,247,246,0.92))] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.88)]">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
        Snapshot
      </p>
      <p className="mt-2 text-lg font-semibold tracking-[-0.03em] text-ink">Top rows</p>
      <div className="mt-4 space-y-3">
        {rows.slice(0, 5).map((row, index) => (
          <div
            key={index}
            className="rounded-[22px] border border-black/[0.06] bg-white/90 px-4 py-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">
                  {String(formatValue(row[xKey]) || "(not set)")}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {series.slice(0, 2).map((item) => (
                    <span
                      key={item.key}
                      className="rounded-full bg-black/[0.04] px-2.5 py-1 text-[11px] font-medium text-ink/75"
                    >
                      {item.label}: {formatValue(row[item.key])}
                    </span>
                  ))}
                </div>
              </div>
              <span className="rounded-full bg-black px-2.5 py-1 text-[11px] font-semibold text-white">
                #{index + 1}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DataTable({ visualization }: { visualization: MessageVisualization }) {
  const rows = visualization.rows ?? [];
  const headers = rows[0] ? Object.keys(rows[0]) : [];

  return (
    <div className="overflow-x-auto rounded-[24px] border border-black/8 bg-white/88 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
      <table className="min-w-full border-collapse text-sm">
        <thead>
          <tr>
            {headers.map((header) => (
              <th
                key={header}
                className="bg-black/[0.04] px-4 py-3 text-left text-[11px] uppercase tracking-[0.16em] text-muted"
              >
                {formatMetricLabel(header)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 8).map((row, index) => (
            <tr key={index}>
              {headers.map((header) => (
                <td key={header} className="border-t border-black/8 px-4 py-3 text-ink/88">
                  {formatValue(row[header])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VisualizationChart({
  visualization,
  series,
}: {
  visualization: MessageVisualization;
  series: ChartSeries[];
}) {
  if (visualization.type === "pie") {
    return <DistributionChart visualization={visualization} series={series} />;
  }

  if (visualization.type === "line" || visualization.type === "area") {
    return <TimeSeriesChart visualization={visualization} series={series} />;
  }

  return <ComparisonChart visualization={visualization} series={series} />;
}

export function MessageVisualizationBlock({ visualization }: { visualization: MessageVisualization }) {
  const rows = visualization.rows ?? [];
  if (!rows.length) {
    return null;
  }

  const xKey = visualization.x_key ?? "label";
  const series = resolveSeries(visualization);
  const overviewCards = buildOverviewCards(rows, xKey, series, visualization.type);
  const badges = buildContextBadges(visualization);

  return (
    <section className="my-7 overflow-hidden rounded-[32px] border border-black/[0.08] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(244,246,249,0.94))] p-5 shadow-[0_22px_55px_rgba(15,23,42,0.06),inset_0_1px_0_rgba(255,255,255,0.92)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
            Dashboard View
          </p>
          <h3 className="mt-2 font-display text-[1.6rem] font-semibold tracking-[-0.04em] text-ink">
            {visualization.title}
          </h3>
          {visualization.subtitle ? (
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">{visualization.subtitle}</p>
          ) : null}
        </div>

        {badges.length ? (
          <div className="flex flex-wrap justify-end gap-2">
            {badges.map((badge) => (
              <span
                key={badge}
                className="rounded-full border border-black/[0.06] bg-white/86 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-ink/78"
              >
                {badge}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {overviewCards.length ? (
        <div className="mt-5 grid gap-3 sm:grid-cols-2 2xl:grid-cols-4 xl:grid-cols-2">
          {overviewCards.map((card) => (
            <div
              key={`${card.label}-${card.value}`}
              className="rounded-[24px] border border-black/[0.06] bg-[linear-gradient(180deg,rgba(255,255,255,0.94),rgba(247,247,246,0.9))] px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.88)]"
            >
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                {card.label}
              </p>
              <p className="mt-3 text-[1.65rem] font-semibold tracking-[-0.05em] text-ink">
                {card.value}
              </p>
              <p className="mt-2 text-sm leading-5 text-muted">{card.hint}</p>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-5 grid gap-5 2xl:grid-cols-[minmax(0,1.8fr)_360px] xl:grid-cols-[minmax(0,1.65fr)_340px]">
        <div className="rounded-[28px] border border-black/[0.06] bg-white/78 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.88)]">
          <VisualizationChart visualization={visualization} series={series} />
        </div>

        <SnapshotPanel rows={rows} xKey={xKey} series={series} />
      </div>

      <div className="mt-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
              Data table
            </p>
            <p className="mt-1 text-sm text-muted">
              The same source data behind the dashboard cards and charts.
            </p>
          </div>
          <span className="rounded-full border border-black/[0.06] bg-white px-3 py-1.5 text-xs font-medium text-muted">
            {rows.length} rows
          </span>
        </div>
        <DataTable visualization={visualization} />
      </div>
    </section>
  );
}

function SupportingVisualizationCard({ visualization }: { visualization: MessageVisualization }) {
  const rows = visualization.rows ?? [];
  if (!rows.length || visualization.type === "table") {
    return null;
  }

  const series = resolveSeries(visualization);

  return (
    <section className="overflow-hidden rounded-[28px] border border-black/[0.08] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(246,247,249,0.95))] p-4 shadow-[0_18px_40px_rgba(15,23,42,0.05),inset_0_1px_0_rgba(255,255,255,0.9)]">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
            Supporting View
          </p>
          <h4 className="mt-2 text-[1.1rem] font-semibold tracking-[-0.03em] text-ink">
            {visualization.title}
          </h4>
          {visualization.subtitle ? (
            <p className="mt-1 text-sm leading-6 text-muted">{visualization.subtitle}</p>
          ) : null}
        </div>
        <span className="rounded-full border border-black/[0.06] bg-white px-3 py-1 text-[11px] font-medium uppercase tracking-[0.12em] text-ink/70">
          {rows.length} rows
        </span>
      </div>

      <div className="rounded-[24px] border border-black/[0.06] bg-white/82 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.88)]">
        <VisualizationChart visualization={visualization} series={series} />
      </div>
    </section>
  );
}

export function MessageVisualizationDashboard({
  visualizations,
}: {
  visualizations: MessageVisualization[];
}) {
  const validVisualizations = visualizations.filter((visualization) => (visualization.rows ?? []).length);
  if (!validVisualizations.length) {
    return null;
  }

  const primaryVisualization =
    validVisualizations.find((visualization) => visualization.type !== "table") ?? validVisualizations[0];
  const supportingVisualizations = validVisualizations.filter(
    (visualization) => visualization !== primaryVisualization && visualization.type !== "table",
  );
  const tableVisualization = validVisualizations.find((visualization) => visualization.type === "table");

  return (
    <div className="space-y-6">
      {primaryVisualization ? <MessageVisualizationBlock visualization={primaryVisualization} /> : null}

      {supportingVisualizations.length ? (
        <section className="grid gap-5 2xl:grid-cols-3 xl:grid-cols-2">
          {supportingVisualizations.map((visualization, index) => (
            <SupportingVisualizationCard
              key={`${visualization.title}-${index}`}
              visualization={visualization}
            />
          ))}
        </section>
      ) : null}

      {tableVisualization ? (
        <section className="rounded-[30px] border border-black/[0.08] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(246,247,249,0.95))] p-5 shadow-[0_20px_48px_rgba(15,23,42,0.05),inset_0_1px_0_rgba(255,255,255,0.9)]">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                Full Table
              </p>
              <h4 className="mt-2 text-[1.2rem] font-semibold tracking-[-0.03em] text-ink">
                {tableVisualization.title}
              </h4>
              {tableVisualization.subtitle ? (
                <p className="mt-1 text-sm leading-6 text-muted">{tableVisualization.subtitle}</p>
              ) : null}
            </div>
            <span className="rounded-full border border-black/[0.06] bg-white px-3 py-1.5 text-xs font-medium text-muted">
              {(tableVisualization.rows ?? []).length} rows
            </span>
          </div>
          <DataTable visualization={tableVisualization} />
        </section>
      ) : null}
    </div>
  );
}
