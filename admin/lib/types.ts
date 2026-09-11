export type SubscriptionStatus = "trial" | "active" | "expired" | "cancelled";
export type TransactionStatus = "pending" | "paid" | "failed";
export type DeviceRole = "Child" | "Parent";

export interface DeviceRow {
  id: string;
  role: DeviceRole;
  pairing_code: string | null;
  latitude: number | null;
  longitude: number | null;
  last_address: string | null;
  last_seen: string | null;
  max_parent_slots: number;
  created_at: string;
}

export interface ChildProfileRow {
  id: string;
  device_id: string;
  full_name: string | null;
  nickname: string;
  settings: Record<string, unknown> | null;
  created_at: string;
}

export interface FamilyLinkRow {
  id: string;
  parent_device_id: string;
  child_device_id: string;
  parent_label: string | null;
  created_at: string;
}

export interface PlanRow {
  id: string;
  name: string;
  description: string | null;
  duration_months: number;
  price: number;
  currency: string;
  is_active: boolean;
  created_at: string;
}

export interface SubscriptionRow {
  id: string;
  child_device_id: string;
  plan_id: string | null;
  status: SubscriptionStatus;
  starts_at: string;
  trial_ends_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TransactionRow {
  id: string;
  transaction_ref: string;
  child_device_id: string;
  plan_id: string | null;
  amount: number;
  currency: string;
  status: TransactionStatus;
  payment_gateway: string;
  raw_payload: Record<string, unknown> | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AppSettingsRow {
  id: boolean;
  web_payment_active: boolean;
  trial_duration_days: number;
  child_grace_period_days: number;
  announcement_text: string | null;
  announcement_active: boolean;
  maintenance_mode: boolean;
  updated_at: string;
}

export interface CustomWordRow {
  id: string;
  child_device_id: string;
  word_id: string;
  word_en: string | null;
  word_zh: string;
  image_url: string | null;
  category_id: string;
  is_favorite: number;
}
