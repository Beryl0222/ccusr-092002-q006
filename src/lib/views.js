// 角色视图：同一笔申请对不同角色给出不同的最小化投影。
// 直属主管只看排班影响，薪酬只看已核准区间，争议处理人经授权看证据链。
import { fail } from "./errors.js";
import { asDate, asInterval, overlaps } from "./intervals.js";
import { lineageRoot } from "./proofs.js";

export function grantAccess(store, input = {}, now = new Date()) {
  const at = asDate(now);
  const { case_id: caseId, grantee, purpose } = input;
  if (!caseId || !grantee || !purpose) fail(400, "授权需要 case_id、grantee 与 purpose");
  const grant = {
    grant_id: store.nextId("GRT"),
    case_id: caseId,
    grantee,
    purpose,
    granted_by: input.granted_by ?? "union-hr-committee",
    granted_at: at.toISOString(),
    expires_at: input.expires_at ?? null,
    revoked: false,
  };
  store.grants.set(grant.grant_id, grant);
  return grant;
}

function requireGrant(store, caseId, grantee, now = new Date()) {
  const at = asDate(now);
  for (const grant of store.grants.values()) {
    if (grant.case_id !== caseId || grant.grantee !== grantee || grant.revoked) continue;
    if (grant.expires_at && Date.parse(grant.expires_at) < at.getTime()) continue;
    return grant;
  }
  fail(403, "争议处理人未获得该个案的有效授权");
}

function getClaim(store, claimId) {
  const claim = store.claims.get(claimId);
  if (!claim) fail(404, `请假申请不存在: ${claimId}`);
  return claim;
}

function latestDecision(store, claimId) {
  const chain = store.decisionsByClaim.get(claimId) ?? [];
  return chain.length > 0 ? store.decisions.get(chain[chain.length - 1]) : null;
}

// 直属主管：只看排班影响。不含证明、排除原因、照护细节与请假类型。
export function supervisorView(store, claimId) {
  const claim = getClaim(store, claimId);
  const decision = latestDecision(store, claimId);
  const approved = decision?.approved ?? [];
  const shifts = (claim.shifts ?? []).map((shift) => {
    const interval = asInterval(shift, "班次");
    const covered = approved.some(
      (piece) =>
        piece.counted_minutes > 0 &&
        overlaps(interval, { start: Date.parse(piece.start), end: Date.parse(piece.end) }),
    );
    return {
      shift_id: shift.shift_id,
      start: shift.start,
      end: shift.end,
      coverage: !decision ? "pending_decision" : covered ? "covered_by_approved_leave" : "not_covered",
    };
  });
  const approvedDays = [
    ...new Set(approved.filter((piece) => piece.counted_minutes > 0).map((piece) => piece.day)),
  ].sort();
  return {
    employee_id: claim.employee_id,
    claim_id: claim.claim_id,
    decision_status: decision ? "decided" : "pending",
    approved_days: approvedDays,
    schedule_impact: shifts,
    summary: {
      shifts_total: shifts.length,
      shifts_covered: shifts.filter((shift) => shift.coverage === "covered_by_approved_leave").length,
    },
  };
}

// 薪酬人员：只看已核准区间与差额，不看证据链与排除明细。
export function payrollView(store, claimId) {
  const claim = getClaim(store, claimId);
  const decision = latestDecision(store, claimId);
  if (!decision) fail(409, "该申请尚无核准决定");
  const adjustments = [...store.adjustments.values()].filter((a) => a.claim_id === claimId);
  return {
    employee_id: claim.employee_id,
    claim_id: claim.claim_id,
    leave_type: claim.leave_type,
    decision_id: decision.decision_id,
    approved_intervals: decision.approved,
    totals: decision.totals,
    adjustments: adjustments.map((a) => ({
      adjustment_id: a.adjustment_id,
      reason: a.reason,
      delta_hours: a.delta_hours,
      created_at: a.created_at,
    })),
  };
}

// 证据链载荷：个案时间线、证明全版本、申请、决定、差额调整。
export function buildDisputePayload(store, caseId) {
  const claims = [...store.claims.values()].filter((claim) => claim.case_id === caseId);
  const proofIds = new Set(claims.flatMap((claim) => claim.proof_ids));
  const proofs = [];
  for (const proofId of proofIds) {
    const root = lineageRoot(store, proofId);
    for (const versionId of store.lineages.get(root) ?? [root]) {
      proofs.push(store.proofs.get(versionId));
    }
  }
  const decisions = claims.flatMap((claim) =>
    (store.decisionsByClaim.get(claim.claim_id) ?? []).map((id) => store.decisions.get(id)),
  );
  const adjustments = [...store.adjustments.values()].filter((a) => a.case_id === caseId);
  return {
    case_id: caseId,
    timeline: store.timelines.get(caseId) ?? null,
    proofs,
    claims,
    decisions,
    adjustments,
  };
}

// 争议处理人：须持有效授权才能查看证据链。
export function disputeView(store, caseId, grantee, now = new Date()) {
  const grant = requireGrant(store, caseId, grantee, now);
  return {
    ...buildDisputePayload(store, caseId),
    authorization: {
      grant_id: grant.grant_id,
      grantee: grant.grantee,
      purpose: grant.purpose,
      expires_at: grant.expires_at,
    },
  };
}
