"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { RevenuePoint, DailyActivePoint } from "@/lib/analytics";

const AXIS = { stroke: "#64748B", fontSize: 11 };
const TOOLTIP_STYLE = {
  backgroundColor: "#0F172A",
  border: "1px solid rgba(148,163,184,0.2)",
  borderRadius: 12,
  color: "#E2E8F0",
  fontSize: 12,
};

export function RevenueChart({ data }: { data: RevenuePoint[] }) {
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#14B8A6" stopOpacity={0.5} />
              <stop offset="100%" stopColor="#14B8A6" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.12)" />
          <XAxis dataKey="monthKey" tick={AXIS} tickLine={false} />
          <YAxis tick={AXIS} tickLine={false} width={72} tickFormatter={(v) => `Rp${v / 1000}k`} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(value: number, name: string) =>
              name === "revenue"
                ? [`Rp${value.toLocaleString("id-ID")}`, "Revenue"]
                : [`Rp${value.toLocaleString("id-ID")}`, "Royalty (10%)"]
            }
          />
          <Area
            type="monotone"
            dataKey="revenue"
            stroke="#14B8A6"
            strokeWidth={2}
            fill="url(#rev)"
          />
          <Area
            type="monotone"
            dataKey="royalty"
            stroke="#38BDF8"
            strokeWidth={1.5}
            fillOpacity={0}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ActiveDevicesChart({ data }: { data: DailyActivePoint[] }) {
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.12)" />
          <XAxis
            dataKey="date"
            tick={AXIS}
            tickLine={false}
            tickFormatter={(v: string) => v.slice(5)}
          />
          <YAxis tick={AXIS} tickLine={false} width={32} allowDecimals={false} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          <Bar dataKey="devices" fill="#0D9488" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
