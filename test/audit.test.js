import assert from "node:assert/strict";
import test from "node:test";

import { reconstructFromPayrollAdjustment } from "../src/lib/audit.js";
import {
  applyArbitration,
  applyProofCorrection,
  decideClaim,
  postPayrollAdjustment,
} from "../src/lib/ledger.js";
import { buildScenario, NOW } from "./helpers.js";

function fullFlow() {
  const scenario = buildScenario();
  const { store, proofA, claimA, claimB } = scenario;
  decideClaim(store, claimA.claim_id, { reviewer: "HR-7", rationale: "首次核准" }, NOW);
  decideClaim(store, claimB.claim_id, { reviewer: "HR-7", rationale: "首次核准" }, NOW);

  // 医院更正住院区间（缩短至 06-07）→ claimA 的远程办理时段落到覆盖外，产生 -2h 差额
  const correction = applyProofCorrection(
    store,
    proofA.proof_id,
    {
      issuer_key: "hosp-key",
      coverage: [
        { kind: "hospitalization", start: "2025-06-04T04:00:00+08:00", end: "2025-06-15T10:00:00+08:00" },
      ],
      rationale: "医院更正出院时间",
    },
    "2025-06-22T09:00:00+08:00",
  );
  // 劳动仲裁恢复轮换重叠 → claimB 产生 +2h 差额
  const arbitration = applyArbitration(
    store,
    "CASE-ICU-12D",
    { reinstate_reasons: ["rotation_overlap"], note: "双亲属夜间共同待命属实", referee: "ARB-王" },
    "2025-07-01T09:00:00+08:00",
  );
  const payrollA = postPayrollAdjustment(
    store,
    {
      period: "2025-06",
      amount_delta: -960,
      adjustment_ids: correction.adjustments.map((a) => a.adjustment_id),
    },
    "2025-07-05T10:00:00+08:00",
  );
  const payrollB = postPayrollAdjustment(
    store,
    {
      period: "2025-07",
      amount_delta: 300,
      adjustment_ids: arbitration.adjustments.map((a) => a.adjustment_id),
    },
    "2025-07-05T10:00:00+08:00",
  );
  return { ...scenario, correction, arbitration, payrollA, payrollB };
}

test("从薪资调整复原制度、凭证状态、排除重叠与复核决定", () => {
  const { store, payrollA, payrollB } = fullFlow();

  const reconstructionA = reconstructFromPayrollAdjustment(store, payrollA.payroll_adjustment_id);
  assert.equal(reconstructionA.payroll_adjustment.amount_delta, -960);
  const claimBlock = reconstructionA.claims[0];

  // 所用制度：当期 v1 快照
  assert.equal(claimBlock.policy.policy_id, "CARE-LEAVE");
  assert.equal(claimBlock.policy.version, 1);
  assert.equal(claimBlock.policy.rules.rotation.mode, "single_active_caregiver");

  // 凭证状态：决定时钉住的版本与当前状态
  assert.equal(claimBlock.credentials.length, 1);
  assert.equal(claimBlock.credentials[0].version, 2);
  assert.equal(claimBlock.credentials[0].status_at_decision, "active");
  assert.equal(claimBlock.credentials[0].status_now, "active");
  assert.equal(claimBlock.credentials[0].signature_ok, true);

  // 排除的重叠时间：年假重叠与重复申报
  const overlapReasons = claimBlock.excluded_overlaps.map((item) => item.reason).sort();
  assert.deepEqual(overlapReasons, ["annual_leave_overlap", "duplicate_within_claim"]);

  // 最终复核决定与完整决定链（初核 → 医院更正 → 仲裁重算）
  assert.equal(claimBlock.final_review.reviewer, "ARB-王");
  assert.deepEqual(
    claimBlock.decision_chain.map((entry) => entry.version),
    [1, 2, 3],
  );

  // claimB 的复原能看到仲裁覆盖层
  const reconstructionB = reconstructFromPayrollAdjustment(store, payrollB.payroll_adjustment_id);
  const blockB = reconstructionB.claims[0];
  assert.equal(blockB.final_review.reviewer, "ARB-王");
  assert.equal(blockB.decision_chain.length, 2);
  assert.ok(blockB.decision_chain[1].overlays.some((overlay) => overlay.type === "arbitration"));
  assert.equal(reconstructionB.payroll_adjustment.delta_hours, 2);
});

test("不存在的薪资调整返回 404", () => {
  const { store } = fullFlow();
  assert.throws(() => reconstructFromPayrollAdjustment(store, "PAY-9999"), /不存在/);
});
