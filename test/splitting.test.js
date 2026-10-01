import assert from "node:assert/strict";
import test from "node:test";

import { decideClaim, fileClaim } from "../src/lib/ledger.js";
import { buildScenario, NOW } from "./helpers.js";

function decideAll() {
  const scenario = buildScenario();
  const decisionA = decideClaim(scenario.store, scenario.claimA.claim_id, { reviewer: "HR-7" }, NOW);
  const decisionB = decideClaim(scenario.store, scenario.claimB.claim_id, { reviewer: "HR-7" }, NOW);
  return { ...scenario, decisionA, decisionB };
}

test("跨午夜待命按自然日拆分并计入各自日期", () => {
  const { decisionA } = decideAll();
  const standby = decisionA.approved.filter((piece) => piece.modality === "standby");
  assert.equal(standby.length, 2);
  assert.deepEqual(
    standby.map((piece) => [piece.day, piece.counted_hours]),
    [
      ["2025-06-03", 4],
      ["2025-06-04", 8],
    ],
  );
});

test("远程办理手续按当期制度折算工时", () => {
  const { decisionA } = decideAll();
  const remote = decisionA.approved.find((piece) => piece.modality === "remote_procedure");
  assert.equal(remote.gross_hours, 4);
  assert.equal(remote.counted_hours, 2); // v1 制度折算 50%
  const ratio = decisionA.excluded.find((item) => item.reason === "remote_procedure_ratio");
  assert.equal(ratio.excluded_hours, 2);
});

test("年假重叠、重复申报与覆盖外时段均被排除", () => {
  const { decisionA } = decideAll();
  const byReason = Object.groupBy(decisionA.excluded, (item) => item.reason);
  assert.equal(byReason.annual_leave_overlap.length, 1);
  assert.equal(byReason.annual_leave_overlap[0].excluded_hours, 8);
  assert.equal(byReason.duplicate_within_claim.length, 1);
  assert.equal(byReason.duplicate_within_claim[0].excluded_hours, 2);
  assert.equal(byReason.outside_proof_coverage.length, 1);
  assert.equal(byReason.outside_proof_coverage[0].excluded_hours, 3);
});

test("亲属轮换同一时段只计一名照护人", () => {
  const { decisionA, decisionB, claimA } = decideAll();
  // 先申报的 claimA 不受影响
  assert.equal(decisionA.totals.counted_hours, 14);
  // 后申报的 claimB 被扣除 06:00-08:00 的重叠
  const rotation = decisionB.excluded.find((item) => item.reason === "rotation_overlap");
  assert.equal(rotation.excluded_hours, 2);
  assert.equal(rotation.allocated_to, claimA.claim_id);
  assert.equal(decisionB.totals.counted_hours, 2);
});

test("核准决定钉住当期制度快照与凭证状态", () => {
  const { decisionA, proofA } = decideAll();
  assert.equal(decisionA.policy.policy_id, "CARE-LEAVE");
  assert.equal(decisionA.policy.version, 1);
  assert.equal(decisionA.policy.rules.remote_procedure.count_ratio, 0.5);
  assert.equal(decisionA.proof_pins.length, 1);
  assert.equal(decisionA.proof_pins[0].proof_id, proofA.proof_id);
  assert.equal(decisionA.proof_pins[0].status, "active");
  assert.equal(decisionA.proof_pins[0].signature_ok, true);
});

test("2026 年的照护适用 v2 当期制度", () => {
  const { store, proofA } = buildScenario();
  const claim = fileClaim(
    store,
    {
      case_id: "CASE-ICU-12D",
      employee_id: "EMP-1001",
      proof_ids: [proofA.proof_id],
      care_periods: [
        { start: "2026-02-01T14:00:00+08:00", end: "2026-02-01T18:00:00+08:00", modality: "remote_procedure" },
      ],
      filed_at: "2026-02-02T09:00:00+08:00",
    },
    "2026-02-02T10:00:00+08:00",
  );
  // 该时段不在任何证明覆盖内，但制度选择仍应按 2026 年取 v2
  const decision = decideClaim(store, claim.claim_id, {}, "2026-02-02T10:00:00+08:00");
  assert.equal(decision.policy.version, 2);
  assert.equal(decision.policy.rules.remote_procedure.count_ratio, 0.6);
});
