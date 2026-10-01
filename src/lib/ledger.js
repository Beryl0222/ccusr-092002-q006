// 台账：请假申请、核准决定、更正与仲裁产生的新版本、差额调整、薪资挂接。
// 所有记录只增不删；每次重算都生成新的决定版本并钉住当时的制度与凭证状态。
import { fail } from "./errors.js";
import { asDate, asInterval, parseMs } from "./intervals.js";
import { policyAt } from "./policy.js";
import { correctProof, latestInLineage, lineageRoot, verifyProof } from "./proofs.js";
import { OVERLAP_REASONS, splitClaimEntitlement } from "./splitting.js";

const MODALITIES = new Set(["standby", "on_site", "remote_procedure"]);

export function fileClaim(store, input = {}, now = new Date()) {
  const at = asDate(now);
  const { case_id: caseId, employee_id: employeeId } = input;
  if (!caseId || !employeeId) fail(400, "请假申请缺少 case_id 或 employee_id");
  const carePeriods = input.care_periods ?? [];
  if (carePeriods.length === 0) fail(400, "请假申请须包含照护时段");
  const proofIds = input.proof_ids ?? [];
  if (proofIds.length === 0) fail(400, "请假申请须关联至少一份证明");
  for (const period of carePeriods) {
    asInterval(period, "照护时段");
    if (period.modality && !MODALITIES.has(period.modality)) {
      fail(400, `未知照护方式: ${period.modality}`);
    }
  }
  for (const leave of input.annual_leave ?? []) asInterval(leave, "年假区间");
  for (const shift of input.shifts ?? []) asInterval(shift, "班次");
  for (const proofId of proofIds) {
    const proof = latestInLineage(store, proofId);
    if (proof.case_id !== caseId) fail(400, `证明 ${proofId} 不属于个案 ${caseId}`);
    if (proof.subject_employee_id !== employeeId) {
      fail(400, `证明 ${proofId} 的照护人与申请人不一致`);
    }
  }
  const claim = {
    claim_id: store.nextId("CLM"),
    case_id: caseId,
    employee_id: employeeId,
    leave_type: input.leave_type ?? "care_leave",
    proof_ids: proofIds,
    care_periods: carePeriods,
    shifts: input.shifts ?? [],
    annual_leave: input.annual_leave ?? [],
    filed_at: input.filed_at ?? at.toISOString(),
  };
  store.claims.set(claim.claim_id, claim);
  return claim;
}

function pinProof(store, proofId, now) {
  const proof = latestInLineage(store, proofId);
  const verification = verifyProof(store, proof.proof_id, now);
  return {
    proof_id: proof.proof_id,
    version: proof.version,
    status: proof.status,
    issuer_id: proof.issuer_id,
    valid_until: proof.valid_until,
    signature_ok: verification.checks.signature_valid,
  };
}

function latestDecision(store, claimId) {
  const chain = store.decisionsByClaim.get(claimId) ?? [];
  return chain.length > 0 ? store.decisions.get(chain[chain.length - 1]) : null;
}

// 核准决定：按照护开始日选取当期制度，快照制度与凭证状态后拆分。
export function decideClaim(store, claimId, input = {}, now = new Date()) {
  const at = asDate(now);
  const claim = store.claims.get(claimId);
  if (!claim) fail(404, `请假申请不存在: ${claimId}`);
  const firstStart = Math.min(...claim.care_periods.map((p) => parseMs(p.start, "照护时段")));
  const policy = policyAt(store, firstStart);
  const result = splitClaimEntitlement(store, claim, {
    policy,
    reinstateReasons: input.reinstate_reasons ?? [],
  });
  const version = (store.decisionsByClaim.get(claimId)?.length ?? 0) + 1;
  const decision = {
    decision_id: store.nextId("DEC"),
    claim_id: claim.claim_id,
    version,
    policy: {
      policy_id: policy.policy_id,
      version: policy.version,
      rules: structuredClone(policy.rules),
    },
    proof_pins: claim.proof_ids.map((id) => pinProof(store, id, at)),
    approved: result.approved,
    excluded: result.excluded,
    totals: result.totals,
    overlays: input.overlays ?? [],
    review: {
      reviewer: input.reviewer ?? "hr-review",
      outcome: input.outcome ?? "approved",
      rationale: input.rationale ?? "",
      decided_at: input.decided_at ?? at.toISOString(),
    },
    created_at: at.toISOString(),
  };
  store.decisions.set(decision.decision_id, decision);
  if (!store.decisionsByClaim.has(claimId)) store.decisionsByClaim.set(claimId, []);
  store.decisionsByClaim.get(claimId).push(decision.decision_id);
  return decision;
}

function recordAdjustment(store, claim, prior, next, reason, note, now) {
  const deltaMinutes = next.totals.counted_minutes - prior.totals.counted_minutes;
  if (deltaMinutes === 0) return null; // 无差额则不产生调整记录
  const adjustment = {
    adjustment_id: store.nextId("ADJ"),
    claim_id: claim.claim_id,
    case_id: claim.case_id,
    employee_id: claim.employee_id,
    from_decision_id: prior.decision_id,
    to_decision_id: next.decision_id,
    reason,
    note,
    delta_minutes: deltaMinutes,
    delta_hours: Math.round((deltaMinutes / 60) * 100) / 100,
    created_at: asDate(now).toISOString(),
  };
  store.adjustments.set(adjustment.adjustment_id, adjustment);
  return adjustment;
}

function recomputeDecidedClaims(store, claims, reason, input, now) {
  const adjustments = [];
  for (const claim of claims) {
    const prior = latestDecision(store, claim.claim_id);
    if (!prior) continue; // 尚未核准的申请不产生差额
    const next = decideClaim(
      store,
      claim.claim_id,
      {
        reviewer: input.reviewer,
        rationale: input.rationale,
        reinstate_reasons: input.reinstate_reasons,
        overlays: input.overlays ? [...(prior.overlays ?? []), ...input.overlays] : prior.overlays,
      },
      now,
    );
    const adjustment = recordAdjustment(store, claim, prior, next, reason, input.note ?? "", now);
    if (adjustment) adjustments.push(adjustment);
  }
  return adjustments;
}

// 医院更正：证明链产生新版本，受影响的已核准申请重算并生成差额调整。
export function applyProofCorrection(store, proofId, input = {}, now = new Date()) {
  const at = asDate(now);
  const { proof } = correctProof(store, proofId, input, at);
  const root = lineageRoot(store, proofId);
  const affected = [...store.claims.values()].filter((claim) =>
    claim.proof_ids.some((id) => lineageRoot(store, id) === root),
  );
  const adjustments = recomputeDecidedClaims(
    store,
    affected,
    "hospital_correction",
    {
      reviewer: input.reviewer ?? "hr-review",
      rationale: input.rationale ?? `医院更正证明 ${proof.proof_id}`,
      note: input.note,
    },
    at,
  );
  return { proof, adjustments };
}

// 劳动仲裁：按裁决恢复被排除的重叠时间，只产生新版本与差额调整。
export function applyArbitration(store, caseId, input = {}, now = new Date()) {
  const at = asDate(now);
  const reinstateReasons = input.reinstate_reasons ?? [];
  for (const reason of reinstateReasons) {
    if (!OVERLAP_REASONS.includes(reason)) {
      fail(400, `仲裁只能恢复重叠类排除项，不支持: ${reason}`);
    }
  }
  const claims = [...store.claims.values()].filter((claim) => claim.case_id === caseId);
  if (claims.length === 0) fail(404, `个案无请假申请: ${caseId}`);
  const arbitrationId = store.nextId("ARB");
  const record = {
    arbitration_id: arbitrationId,
    case_id: caseId,
    reinstate_reasons: reinstateReasons,
    note: input.note ?? "",
    referee: input.referee ?? "arbitration",
    created_at: at.toISOString(),
  };
  store.arbitrations.set(arbitrationId, record);
  const adjustments = recomputeDecidedClaims(
    store,
    claims,
    "arbitration",
    {
      reviewer: input.referee ?? "arbitration",
      rationale: input.note ?? "劳动仲裁结果执行",
      reinstate_reasons: reinstateReasons,
      overlays: [{ type: "arbitration", ref: arbitrationId, note: input.note ?? "" }],
      note: input.note,
    },
    at,
  );
  return { arbitration: record, adjustments };
}

// 薪资调整：把一笔薪酬变动挂到假期差额调整上，供审计反向复原。
export function postPayrollAdjustment(store, input = {}, now = new Date()) {
  const at = asDate(now);
  const ids = input.adjustment_ids ?? [];
  if (ids.length === 0) fail(400, "薪资调整须关联至少一条假期差额调整");
  const adjustments = ids.map((id) => {
    const adjustment = store.adjustments.get(id);
    if (!adjustment) fail(404, `差额调整不存在: ${id}`);
    return adjustment;
  });
  const employeeIds = new Set(adjustments.map((a) => a.employee_id));
  if (employeeIds.size !== 1) fail(400, "一笔薪资调整只能对应一名员工");
  const totalMinutes = adjustments.reduce((sum, a) => sum + a.delta_minutes, 0);
  const record = {
    payroll_adjustment_id: store.nextId("PAY"),
    employee_id: adjustments[0].employee_id,
    period: input.period ?? null,
    amount_delta: input.amount_delta ?? 0,
    currency: input.currency ?? "CNY",
    adjustment_ids: ids,
    delta_hours: Math.round((totalMinutes / 60) * 100) / 100,
    posted_by: input.posted_by ?? "payroll",
    posted_at: at.toISOString(),
  };
  store.payrollAdjustments.set(record.payroll_adjustment_id, record);
  return record;
}
