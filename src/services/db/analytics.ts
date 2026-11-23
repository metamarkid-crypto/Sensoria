/**
 * analytics.ts — Pure activity calculation engine for ParentHomeScreen.
 *
 * Extracted from ParentHomeScreen to keep the UI screen thin and allow
 * direct unit testing in plain Node without Metro/React Native.
 *
 * Correctness guarantees:
 *  • timestamps normalized via toTimestampMs (PostgREST bigint strings supported)
 *  • unique words preserve CJK characters for quad-lingual vocabulary counting
 *  • messages = child requests + parent responses
 */
import { toTimestampMs } from '../../utils/format';

export type ActivityRange = 'today' | '7d' | '30d';

export interface ActivityStats {
  messages: number;
  requests: number;
  responses: number;
  uniqueWords: number;
  activeDays: number;
  chart: number[];
  chartLabels: string[];
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Inclusive lower bound (epoch ms) for a range, ending at `nowMs`. */
export function rangeStartMs(range: ActivityRange, nowMs: number): number {
  if (range === 'today') {
    const d = new Date(nowMs);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  const days = range === '7d' ? 7 : 30;
  return nowMs - (days - 1) * DAY_MS;
}

export function dayStartMs(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function computeActivity(
  rows: Array<{ sender_role?: string; text_content?: string | null; timestamp?: unknown }>,
  range: ActivityRange,
  nowMs: number,
): ActivityStats {
  const child = rows.filter((r) => r.sender_role === 'Child');
  const parent = rows.filter((r) => r.sender_role === 'Parent');

  const words = new Set<string>();
  const activeDays = new Set<string>();

  let chart: number[];
  let chartLabels: string[];

  if (range === 'today') {
    chart = new Array(24).fill(0);
    chartLabels = ['00', '04', '08', '12', '16', '20', '24'];
  } else if (range === '7d') {
    chart = new Array(7).fill(0);
    chartLabels = new Array(7).fill(0).map((_, i) =>
      String(new Date(nowMs - (6 - i) * DAY_MS).getDate()),
    );
  } else {
    chart = new Array(30).fill(0);
    chartLabels = [];
    for (let i = 0; i < 30; i += 5) {
      chartLabels.push(String(new Date(nowMs - (29 - i) * DAY_MS).getDate()));
    }
  }

  for (const m of child) {
    const ms = toTimestampMs(m.timestamp);
    if (Number.isNaN(ms)) continue;

    if (m.text_content) {
      String(m.text_content)
        .toLowerCase()
        .split(/\s+/)
        .forEach((w: string) => {
          const clean = w.replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
          if (clean) words.add(clean);
        });
    }

    const d = new Date(ms);
    activeDays.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);

    if (range === 'today') {
      chart[d.getHours()]++;
    } else {
      const days = range === '7d' ? 7 : 30;
      const daysAgo = Math.round((dayStartMs(nowMs) - dayStartMs(ms)) / DAY_MS);
      const idx = days - 1 - daysAgo;
      if (idx >= 0 && idx < days) chart[idx]++;
    }
  }

  return {
    messages: child.length + parent.length,
    requests: child.length,
    responses: parent.length,
    uniqueWords: words.size,
    activeDays: activeDays.size,
    chart,
    chartLabels,
  };
}

export const EMPTY_ACTIVITY: ActivityStats = {
  messages: 0,
  requests: 0,
  responses: 0,
  uniqueWords: 0,
  activeDays: 0,
  chart: new Array(24).fill(0),
  chartLabels: ['00', '04', '08', '12', '16', '20', '24'],
};
