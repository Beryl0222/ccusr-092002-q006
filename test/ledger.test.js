import assert from "node:assert/strict";
import test from "node:test";

import {
  applyArbitration,
  applyProofCorrection,
  decideClaim,
  postPayrollAdjustment,
} from "../src/lib/ledger.js";
import { buildScenario, NOW } from "./helpers.js";

function decidedScenario() {
  const scenario = buildScenario();
  const decisionA1 = decideClaim(scenario.store, scenario.claimA.claim_id, { reviewer: "HR-7" }, NOW);
  const decisionB1 = decideClaim(scenario.store, scenario.claimB.claim_id, { reviewer: "HR-7" }, NOW);
  return { ...scenario, decisionA1, decisionB1 };
}

test("医院更正只产生新版本与差额调整", () => {
  const { store, proofA, claimA, claimB } = decidedScenario();
  const { proof: v2, adjustments } = applyProofCorrection(
    store,
    proofA.proof_id,
    {
      issuer_key: "hosp-key",
      coverage: [
        { kind: "hospitalization", start: "2025-06-04T04:00:00+08:00", end: "2025-06-15T10:00:00+08:00" },
      ],
    },
    "2025-06-22T09:00:00+08:00",
  );
  assert.equal(v2.version, 2);
  // 只有关联该证明链的 claimA 受影响：远程办理时段落到覆盖外，减少 2 小时
  assert.equal(adjustments.length, 1);
  assert.equal(adjustments[0].claim_id, claimA.claim_id);
  assert.equal(adjustments[0].reason, "hospital_correction");
  assert.equal(adjustments[0].delta_hours, -8);

  const chainA = store.decisionsByClaim.get(claimA.claim_id);
  assert.equal(chainA.length, 2);
  const latest = store.decisions.get(chainA[chainA.length - 1]);
  assert.equal(latest.totals.counted_hours, 6);
  assert.equal(latest.proof_pins[0].proof_id, v2.proof_id);
  // claimB 关联另一条证明链，不被重算
  assert.equal(store.decisionsByClaim.get(claimB.claim_id).length, 1);
});

test("劳动仲裁恢复被排除的轮换重叠，只产生新版本与差额", () => {
  const { store, claimA, claimB } = decidedScenario();
  const { arbitration, adjustments } = applyArbitration(
    store,
    "CASE-ICU-12D",
    { reinstate_reasons: ["rotation_overlap"], note: "双亲属夜间共同待命属实", referee: "ARB-王" },
    "2025-07-01T09:00:00+08:00",
  );
  assert.ok(arbitration.arbitration_id);
  // claimA 没有轮换排除项，差额为 0 不产生调整；claimB 恢复 2 小时
  assert.equal(adjustments.length, 1);
  assert.equal(adjustments[0].claim_id, claimB.claim_id);
  assert.equal(adjustments[0].reason, "arbitration");
  assert.equal(adjustments[0].delta_hours, 2);

  const chainB = store.decisionsByClaim.get(claimB.claim_id);
  const latestB = store.decisions.get(chainB[chainB.length - 1]);
  assert.equal(latestB.totals.counted_hours, 4);
  assert.ok(latestB.approved.some((piece) => piece.reinstated));
  assert.equal(latestB.overlays.length, 1);
  assert.equal(latestB.overlays[0].type, "arbitration");
  // claimA 也留下新版本（内容不变），保证链条完整
  assert.equal(store.decisionsByClaim.get(claimA.claim_id).length, 2);
});

test("仲裁不允许恢复非重叠类排除项", () => {
  const { store } = decidedScenario();
  assert.throws(
    () => applyArbitration(store, "CASE-ICU-12D", { reinstate_reasons: ["remote_procedure_ratio"] }, NOW),
    /重叠类/,
  );
});

test("薪资调整挂接差额调整并汇总工时", () => {
  const { store, proofA } = decidedScenario();
  const { adjustments } = applyProofCorrection(
    store,
    proofA.proof_id,
    {
      issuer_key: "hosp-key",
      coverage: [
        { kind: "hospitalization", start: "2025-06-04T04:00:00+08:00", end: "2025-06-15T10:00:00+08:00" },
      ],
    },
    "2025-06-22T09:00:00+08:00",
  );
  const payroll = postPayrollAdjustment(
    store,
    {
      period: "2025-06",
      amount_delta: -960,
      adjustment_ids: adjustments.map((a) => a.adjustment_id),
      posted_by: "PAY-09",
    },
    "2025-06-30T10:00:00+08:00",
  );
  assert.equal(payroll.employee_id, "EMP-1001");
  assert.equal(payroll.delta_hours, -8);
  assert.equal(payroll.amount_delta, -960);
});

test("一笔薪资调整不能跨员工", () => {
  const { store, proofA } = decidedScenario();
  applyProofCorrection(
    store,
    proofA.proof_id,
    {
      issuer_key: "hosp-key",
      coverage: [
        { kind: "hospitalization", start: "2025-06-04T04:00:00+08:00", end: "2025-06-15T10:00:00+08:00" },
      ],
    },
    "2025-06-22T09:00:00+08:00",
  );
  const { adjustments: arbAdjustments } = applyArbitration(
    store,
    "CASE-ICU-12D",
    { reinstate_reasons: ["rotation_overlap"] },
    "2025-07-01T09:00:00+08:00",
  );
  const allIds = [...store.adjustments.keys()];
  assert.equal(allIds.length, 2);
  assert.throws(
    () => postPayrollAdjustment(store, { adjustment_ids: allIds }, NOW),
    /只能对应一名员工/,
  );
  assert.equal(arbAdjustments.length, 1);
});
