import { createServiceClient } from "@/lib/supabase/server";
import type { PlanRow, SubscriptionRow, SubscriptionStatus } from "@/lib/types";

export interface SubOverviewItem {
  subscription: SubscriptionRow;
  childNickname: string | null;
  planName: string | null;
  planPrice: number | null;
  /** Projected expiry if a 1-month plan were stacked today (30.4375d/month). */
  projectedIfPlusOneMonth: string | null;
}

const AVG_DAYS_PER_MONTH = 30.4375;

/**
 * Same stacking rule as computeStackedExpiry() on the mobile client and
 * apply_plan_purchase() on the server — future end appends, past end restarts.
 */
export function computeStackedExpiry(
  currentEndAt: string | null,
  months: number,
  now = Date.now(),
): string {
  const endMs = currentEndAt ? new Date(currentEndAt).getTime() : NaN;
  const base = Number.isFinite(endMs) && endMs > now ? endMs : now;
  return new Date(base + months * AVG_DAYS_PER_MONTH * 86400_000).toISOString();
}

export async function getSubscriptionsOverview(): Promise<{
  plans: PlanRow[];
  items: SubOverviewItem[];
}> {
  const db = createServiceClient();

  const [plansRes, subsRes, profilesRes] = await Promise.all([
    db.from("plans").select("*").order("duration_months", { ascending: true }),
    db
      .from("subscriptions")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(500),
    db.from("child_profiles").select("device_id, nickname, full_name"),
  ]);

  for (const r of [plansRes, subsRes, profilesRes]) if (r.error) throw r.error;

  const plans = (plansRes.data ?? []) as PlanRow[];
  const planById = new Map(plans.map((p) => [p.id, p]));
  const profileByDevice = new Map(
    ((profilesRes.data ?? []) as Array<{ device_id: string; nickname: string; full_name: string | null }>).map(
      (p) => [p.device_id, p.nickname || p.full_name],
    ),
  );

  const items: SubOverviewItem[] = ((subsRes.data ?? []) as SubscriptionRow[]).map(
    (sub) => {
      const plan = sub.plan_id ? planById.get(sub.plan_id) : undefined;
      const endAt =
        sub.status === "trial" ? sub.trial_ends_at : sub.expires_at;
      return {
        subscription: sub,
        childNickname: profileByDevice.get(sub.child_device_id) ?? null,
        planName: plan?.name ?? null,
        planPrice: plan ? Number(plan.price) : null,
        projectedIfPlusOneMonth:
          sub.status === "active" || sub.status === "trial"
            ? computeStackedExpiry(endAt, 1)
            : null,
      };
    },
  );

  return { plans, items };
}
