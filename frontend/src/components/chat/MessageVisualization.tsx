"use client";

import type { MessageVisualization } from "@/lib/types";

function getNumericExtent(rows: Record<string, string | number | null>[], seriesKeys: string[]) {
  const values = rows.flatMap((row) =>
    seriesKeys
      .map((key) => row[key])
      .filter((value): value is number => typeof value === "number"),
  );
  const max = Math.max(...values, 0);
  return { max: max <= 0 ? 1 : max };
}

function defaultColor(index: number) {
  const palette = ["#111111", "#2563eb", "#059669", "#ea580c", "#7c3aed"];
  return palette[index % palette.length];
}

function formatValue(value: string | number | null | undefined) {
  if (typeof value === "number") {
    return value.toLocaleString();
  }
  return value ?? "";
}

function LineChart({ visualization }: { visualization: MessageVisualization }) {
  const rows = visualization.rows ?? [];
  const xKey = visualization.x_key ?? "label";
  const series = visualization.series ?? [];
  const width = 760;
  const height = 260;
  const padX = 28;
  const padY = 20;
  const chartWidth = width - padX * 2;
  const chartHeight = height - padY * 2;
  const { max } = getNumericExtent(rows, series.map((item) => item.key));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full">
      <rect x="0" y="0" width={width} height={height} rx="20" fill="rgba(17,17,17,0.02)" />
      {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
        const y = padY + chartHeight - chartHeight * tick;
        return <line key={tick} x1={padX} y1={y} x2={padX + chartWidth} y2={y} stroke="rgba(17,17,17,0.08)" strokeWidth="1" />;
      })}
      {series.map((item, seriesIndex) => {
        const color = item.color || defaultColor(seriesIndex);
        const path = rows
          .map((row, index) => {
            const raw = row[item.key];
            const value = typeof raw === "number" ? raw : Number(raw ?? 0);
            const x = padX + (rows.length <= 1 ? chartWidth / 2 : (chartWidth * index) / (rows.length - 1));
            const y = padY + chartHeight - (chartHeight * value) / max;
            return `${index === 0 ? "M" : "L"} ${x} ${y}`;
          })
          .join(" ");

        return (
          <g key={item.key}>
            <path d={path} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            {rows.map((row, index) => {
              const raw = row[item.key];
              const value = typeof raw === "number" ? raw : Number(raw ?? 0);
              const x = padX + (rows.length <= 1 ? chartWidth / 2 : (chartWidth * index) / (rows.length - 1));
              const y = padY + chartHeight - (chartHeight * value) / max;
              return (
                <circle key={`${item.key}-${index}`} cx={x} cy={y} r="4" fill={color}>
                  <title>{`${formatValue(row[xKey])}: ${item.label} ${formatValue(value)}`}</title>
                </circle>
              );
            })}
          </g>
        );
      })}
      {rows.map((row, index) => {
        const x = padX + (rows.length <= 1 ? chartWidth / 2 : (chartWidth * index) / (rows.length - 1));
        return (
          <text key={index} x={x} y={height - 8} textAnchor="middle" fontSize="11" fill="rgba(17,17,17,0.55)">
            {String(formatValue(row[xKey])).slice(5)}
          </text>
        );
      })}
    </svg>
  );
}

function BarChart({ visualization }: { visualization: MessageVisualization }) {
  const rows = visualization.rows ?? [];
  const xKey = visualization.x_key ?? "label";
  const series = visualization.series ?? [];
  const width = 760;
  const height = 300;
  const padX = 28;
  const padY = 20;
  const chartWidth = width - padX * 2;
  const chartHeight = height - padY * 2 - 30;
  const primary = series[0];
  const { max } = getNumericExtent(rows, primary ? [primary.key] : []);
  const barWidth = rows.length ? chartWidth / rows.length : 0;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full">
      <rect x="0" y="0" width={width} height={height} rx="20" fill="rgba(17,17,17,0.02)" />
      {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
        const y = padY + chartHeight - chartHeight * tick;
        return <line key={tick} x1={padX} y1={y} x2={padX + chartWidth} y2={y} stroke="rgba(17,17,17,0.08)" strokeWidth="1" />;
      })}
      {rows.map((row, index) => {
        const raw = primary ? row[primary.key] : 0;
        const value = typeof raw === "number" ? raw : Number(raw ?? 0);
        const barHeight = (chartHeight * value) / max;
        const x = padX + index * barWidth + 8;
        const y = padY + chartHeight - barHeight;
        const color = primary?.color || defaultColor(0);
        return (
          <g key={index}>
            <rect x={x} y={y} width={Math.max(barWidth - 16, 12)} height={barHeight} rx="10" fill={color}>
              <title>{`${formatValue(row[xKey])}: ${primary?.label ?? "value"} ${formatValue(value)}`}</title>
            </rect>
            <text x={x + Math.max(barWidth - 16, 12) / 2} y={height - 10} textAnchor="middle" fontSize="11" fill="rgba(17,17,17,0.55)">
              {String(formatValue(row[xKey])).slice(0, 14)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function DataTable({ visualization }: { visualization: MessageVisualization }) {
  const rows = visualization.rows ?? [];
  const headers = rows[0] ? Object.keys(rows[0]) : [];

  return (
    <div className="overflow-x-auto rounded-[22px] border border-black/8 bg-white">
      <table className="min-w-full border-collapse text-sm">
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} className="bg-black/[0.04] px-4 py-3 text-left text-[11px] uppercase tracking-[0.18em] text-muted">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {headers.map((header) => (
                <td key={header} className="border-t border-black/8 px-4 py-3 text-ink/85">
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

export function MessageVisualizationBlock({ visualization }: { visualization: MessageVisualization }) {
  const hasRows = (visualization.rows ?? []).length > 0;
  if (!hasRows) {
    return null;
  }

  return (
    <section className="my-6 rounded-[28px] border border-black/8 bg-black/[0.02] p-4">
      <div className="mb-4">
        <p className="text-sm font-semibold text-ink">{visualization.title}</p>
        {visualization.subtitle ? (
          <p className="mt-1 text-xs uppercase tracking-[0.16em] text-muted">{visualization.subtitle}</p>
        ) : null}
      </div>
      {visualization.type === "line" || visualization.type === "area" ? (
        <LineChart visualization={visualization} />
      ) : visualization.type === "bar" || visualization.type === "stacked_bar" ? (
        <BarChart visualization={visualization} />
      ) : null}
      <div className="mt-4">
        <DataTable visualization={visualization} />
      </div>
    </section>
  );
}
