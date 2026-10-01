// 审计复原：从一笔薪资调整反推出当时所用的制度、凭证状态、
// 被排除的重叠时间和最终复核决定。
import { fail } from "./errors.js";
import { HOUR_ADJUST_REASONS, OVERLAP_REASONS } from "./splitting.js";

export function reconstructFromPayrollAdjustment(store, payrollAdjustmentId) {
  const payroll = store.payrollAdjustments.get(payrollAdjustmentId);
  if (!payroll) fail(404, `薪资调整不存在: ${payrollAdjustmentId}`);
  const adjustments = payroll.adjustment_ids.map((id) => store.adjustments.get(id));
  const claimIds = [...new Set(adjustments.map((a) => a.claim_id))];
  const claims = claimIds.map((claimId) => {
    const chain = (store.decisionsByClaim.get(claimId) ?? []).map((id) => store.decisions.get(id));
    const finalDecision = chain[chain.length - 1];
    const credentials = finalDecision.proof_pins.map((pin) => {
      const current = store.proofs.get(pin.proof_id);
      return {
        proof_id: pin.proof_id,
        version: pin.version,
        issuer_id: pin.issuer_id,
        status_at_decision: pin.status,
        status_now: current?.status ?? "unknown",
        valid_until: pin.valid_until,
        signature_ok: pin.signature_ok,
      };
    });
    return {
      claim_id: claimId,
      policy: finalDecision.policy,
      credentials,
      excluded_overlaps: finalDecision.excluded.filter((item) =>
        OVERLAP_REASONS.includes(item.reason),
      ),
      other_exclusions: finalDecision.excluded.filter(
        (item) => !OVERLAP_REASONS.includes(item.reason) && !HOUR_ADJUST_REASONS.includes(item.reason),
      ),
      hour_adjustments: finalDecision.excluded.filter((item) =>
        HOUR_ADJUST_REASONS.includes(item.reason),
      ),
      final_review: finalDecision.review,
      decision_chain: chain.map((decision) => ({
        decision_id: decision.decision_id,
        version: decision.version,
        created_at: decision.created_at,
        counted_hours: decision.totals.counted_hours,
        overlays: decision.overlays,
      })),
      adjustments: adjustments.filter((a) => a.claim_id === claimId),
    };
  });
  return { payroll_adjustment: payroll, claims };
}
