"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { compactNPR, formatNPR, toNumber } from "@/lib/format";
import { formatAD, isoToBS, isoToBSShort } from "@/lib/nepali-date";
import type { DashboardSummary } from "@/lib/dashboard";

// Recharts writes colours as SVG attributes, which cannot use CSS var(); keep
// these in sync with the brand tokens in globals.css.
const COLORS = {
  bar: "#1E3A5F", // --primary
  barToday: "#F28C28", // --saffron
  grid: "#D8DEE6", // --border
  tick: "#556170", // --muted-foreground
  cursor: "#EAF0F6", // --accent
};

interface Point {
  date: string;
  label: string;
  total: number;
  raw: string;
}

/** Sales for the last 7 days, labelled with BS dates (AD in the tooltip). */
export function SalesChart({ days }: { days: DashboardSummary["salesLast7Days"] }) {
  const data: Point[] = days.map((d) => ({
    date: d.date,
    label: isoToBSShort(d.date),
    total: toNumber(d.total),
    raw: d.total,
  }));
  const week = days.reduce((s, d) => s + toNumber(d.total), 0);

  return (
    <figure className="w-full">
      <figcaption className="sr-only">
        Sales in the last 7 days:{" "}
        {days.map((d) => `${isoToBS(d.date)} ${formatNPR(d.total)}`).join("; ")}. Total{" "}
        {formatNPR(week.toFixed(2))}.
      </figcaption>
      <div className="h-64 w-full" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={COLORS.grid} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tick={{ fill: COLORS.tick, fontSize: 12 }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={48}
              tickFormatter={(v: number) => compactNPR(v)}
              tick={{ fill: COLORS.tick, fontSize: 12 }}
            />
            <Tooltip
              cursor={{ fill: COLORS.cursor }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as Point;
                return (
                  <div className="rounded-md border bg-card px-3 py-2 text-sm shadow-md">
                    <p className="font-medium text-nepali">{isoToBS(p.date)} BS</p>
                    <p className="text-xs text-muted-foreground">{formatAD(p.date)}</p>
                    <p className="mt-1 font-semibold tabular-nums">{formatNPR(p.raw)}</p>
                  </div>
                );
              }}
            />
            <Bar dataKey="total" radius={[4, 4, 0, 0]} maxBarSize={44}>
              {data.map((p, i) => (
                <Cell key={p.date} fill={i === data.length - 1 ? COLORS.barToday : COLORS.bar} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
