// 照护假制度：按生效日版本化，同一申请跨越制度换版时按当期拆分适用。
// 制度只规定假别资格、额度、付薪比例与适用事件，不涉及任何诊断信息。

import { localDayOf, parseInstant } from "./time.js";

export const LEAVE_KINDS = [
  "icu_care_leave", // 重症照护假（带薪/部分带薪，依制度）
  "family_care_leave", // 普通家庭照护假
  "standby_duty", // 待命值守（不计缺勤）
  "personal_affairs", // 事假（兜底）
  "annual_leave", // 年假（优先抵扣重叠时间）
  "remote_work", // 远程办公（办理手续时段）
];

function assertRule(rule) {
  if (!LEAVE_KINDS.includes(rule.kind)) throw new Error(`未知假别: ${rule.kind}`);
  if (typeof rule.pay_rate !== "number" || rule.pay_rate < 0 || rule.pay_rate > 1) {
    throw new Error(`假别 ${rule.kind} 的 pay_rate 须在 0~1`);
  }
  if (rule.max_calendar_days !== undefined && rule.max_calendar_days <= 0) {
    throw new Error(`假别 ${rule.kind} 额度无效`);
  }
}

export function buildPolicyBook(versions, { offsetMinutes = 480 } = {}) {
  const sorted = [...versions].sort(
    (a, b) => parseInstant(a.effective_from) - parseInstant(b.effective_from),
  );
  for (const version of sorted) {
    if (!version.id || !version.effective_from) throw new Error("制度版本缺少 id 或生效日");
    for (const rule of version.rules) assertRule(rule);
    const kinds = new Set(version.rules.map((rule) => rule.kind));
    if (!kinds.has("icu_care_leave")) throw new Error("制度必须包含重症照护假规则");
  }

  // 依据时刻选择当期制度。
  function versionAt(instantIso) {
    const t = parseInstant(instantIso);
    let chosen = null;
    for (const version of sorted) {
      if (parseInstant(version.effective_from) <= t) chosen = version;
    }
    if (!chosen) throw new Error(`时刻 ${instantIso} 没有适用的制度版本`);
    return chosen;
  }

  function ruleAt(kind, instantIso) {
    const rule = versionAt(instantIso).rules.find((item) => item.kind === kind);
    if (!rule) throw new Error(`制度在 ${instantIso} 未规定假别 ${kind}`);
    return rule;
  }

  // 按本地日列出区间覆盖到的各当期制度（用于跨版本拆分）。
  function versionsCovering(dayIntervals) {
    const map = new Map();
    for (const piece of dayIntervals) {
      const version = versionAt(`${piece.day}T12:00:00+08:00`);
      if (!map.has(version.id)) {
        map.set(version.id, {
          policy_id: version.id,
          effective_from: version.effective_from,
          title: version.title,
          offsetMinutes,
        });
      }
    }
    return [...map.values()];
  }

  return {
    offsetMinutes,
    versionAt,
    ruleAt,
    versionsCovering,
    dayAt: (instantIso) => localDayOf(parseInstant(instantIso), offsetMinutes),
  };
}

export function defaultPolicyVersions() {
  return [
    {
      id: "POL-2025",
      title: "员工家属重症照护假管理办法（2025版）",
      effective_from: "2025-01-01T00:00:00+08:00",
      rules: [
        {
          kind: "icu_care_leave",
          label: "重症照护假",
          max_calendar_days: 5,
          pay_rate: 1,
          eligible_events: ["admission", "critical_notice", "urgent_consent", "standby_request"],
          daily_hours_cap: 24,
          remote_eligible: false,
        },
        {
          kind: "family_care_leave",
          label: "家庭照护假",
          max_calendar_days: 3,
          pay_rate: 0.8,
          eligible_events: ["discharge", "transfer", "document_handling"],
          daily_hours_cap: 8,
          remote_eligible: true,
        },
        {
          kind: "standby_duty",
          label: "待命值守",
          pay_rate: 1,
          eligible_events: ["standby_request"],
          daily_hours_cap: 24,
          remote_eligible: true,
          note: "院方要求待命但未实际离岗，不计缺勤",
        },
        {
          kind: "annual_leave",
          label: "年假",
          pay_rate: 1,
          eligible_events: "*",
          daily_hours_cap: 8,
        },
        {
          kind: "remote_work",
          label: "远程办公",
          pay_rate: 1,
          eligible_events: ["document_handling", "transfer"],
          daily_hours_cap: 8,
          remote_required: true,
        },
        {
          kind: "personal_affairs",
          label: "事假",
          pay_rate: 0,
          eligible_events: "*",
          daily_hours_cap: 8,
        },
      ],
    },
    {
      id: "POL-2026",
      title: "员工家属重症照护假管理办法（2026版）",
      effective_from: "2026-01-01T00:00:00+08:00",
      rules: [
        {
          kind: "icu_care_leave",
          label: "重症照护假",
          max_calendar_days: 7,
          pay_rate: 1,
          eligible_events: ["admission", "critical_notice", "urgent_consent", "standby_request", "transfer"],
          daily_hours_cap: 24,
          remote_eligible: false,
        },
        {
          kind: "family_care_leave",
          label: "家庭照护假",
          max_calendar_days: 4,
          pay_rate: 0.8,
          eligible_events: ["discharge", "transfer", "document_handling"],
          daily_hours_cap: 8,
          remote_eligible: true,
        },
        {
          kind: "standby_duty",
          label: "待命值守",
          pay_rate: 1,
          eligible_events: ["standby_request"],
          daily_hours_cap: 24,
          remote_eligible: true,
        },
        {
          kind: "annual_leave",
          label: "年假",
          pay_rate: 1,
          eligible_events: "*",
          daily_hours_cap: 8,
        },
        {
          kind: "remote_work",
          label: "远程办公",
          pay_rate: 1,
          eligible_events: ["document_handling", "transfer"],
          daily_hours_cap: 8,
          remote_required: true,
        },
        {
          kind: "personal_affairs",
          label: "事假",
          pay_rate: 0,
          eligible_events: "*",
          daily_hours_cap: 8,
        },
      ],
    },
  ];
}
