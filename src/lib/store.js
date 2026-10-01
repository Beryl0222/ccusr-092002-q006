// 内存台账：所有记录只增不删，更正与仲裁通过新版本体现。
import { fail } from "./errors.js";
import { DEFAULT_POLICIES } from "./policy.js";

export function createStore({ policies = DEFAULT_POLICIES } = {}) {
  let sequence = 0;
  return {
    policies: structuredClone(policies),
    issuers: new Map(), // issuer_id -> { issuer_id, kind, name, key }
    proofs: new Map(), // proof_id -> proof（含 status，签名内容不可变）
    lineages: new Map(), // 链根 proof_id -> [proof_id, ...] 版本链
    claims: new Map(), // claim_id -> 请假申请
    decisions: new Map(), // decision_id -> 核准决定
    decisionsByClaim: new Map(), // claim_id -> [decision_id, ...]
    adjustments: new Map(), // adjustment_id -> 假期差额调整
    payrollAdjustments: new Map(), // payroll_adjustment_id -> 薪资调整
    arbitrations: new Map(), // arbitration_id -> 仲裁记录
    grants: new Map(), // grant_id -> 争议查看授权
    timelines: new Map(), // case_id -> 个案证据时间线
    nextId(prefix) {
      sequence += 1;
      return `${prefix}-${String(sequence).padStart(4, "0")}`;
    },
  };
}

export function loadTimeline(store, timeline) {
  if (!timeline?.case_id) fail(400, "个案时间线缺少 case_id");
  store.timelines.set(timeline.case_id, timeline);
  return { case_id: timeline.case_id, events: timeline.events?.length ?? 0 };
}
