// 当期制度登记：制度按版本生效，拆分时按照护发生日选取当期版本，
// 并把制度快照钉进核准决定，供事后审计复原。
import { fail } from "./errors.js";
import { parseMs } from "./intervals.js";

export const DEFAULT_POLICIES = [
  {
    policy_id: "CARE-LEAVE",
    version: 1,
    effective_from: "2025-01-01T00:00:00+08:00",
    rules: {
      timezone_offset_minutes: 480,
      cross_midnight: "split_by_calendar_day",
      remote_procedure: { count_ratio: 0.5, max_hours_per_day: 4 },
      rotation: { mode: "single_active_caregiver", tie_break: "earliest_claim" },
      annual_leave_overlap: "exclude",
      duplicate_upload: "ignore",
    },
  },
  {
    policy_id: "CARE-LEAVE",
    version: 2,
    effective_from: "2026-01-01T00:00:00+08:00",
    rules: {
      timezone_offset_minutes: 480,
      cross_midnight: "split_by_calendar_day",
      remote_procedure: { count_ratio: 0.6, max_hours_per_day: 6 },
      rotation: { mode: "single_active_caregiver", tie_break: "earliest_claim" },
      annual_leave_overlap: "exclude",
      duplicate_upload: "ignore",
    },
  },
];

export function policyAt(store, atMs) {
  const candidates = store.policies
    .filter((policy) => parseMs(policy.effective_from, "制度生效时间") <= atMs)
    .sort((a, b) => parseMs(a.effective_from) - parseMs(b.effective_from));
  if (candidates.length === 0) fail(500, "没有可用的当期制度");
  return candidates[candidates.length - 1];
}
