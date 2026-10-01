import assert from "node:assert/strict";
import test from "node:test";

import { decideClaim } from "../src/lib/ledger.js";
import { disclosurePreview } from "../src/lib/disclosure.js";
import { disputeView, grantAccess, payrollView, supervisorView } from "../src/lib/views.js";
import { buildScenario, NOW } from "./helpers.js";

function decidedScenario() {
  const scenario = buildScenario();
  decideClaim(scenario.store, scenario.claimA.claim_id, { reviewer: "HR-7" }, NOW);
  decideClaim(scenario.store, scenario.claimB.claim_id, { reviewer: "HR-7" }, NOW);
  return scenario;
}

test("直属主管只能看到排班影响", () => {
  const { store, claimA } = decidedScenario();
  const view = supervisorView(store, claimA.claim_id);
  assert.equal(view.decision_status, "decided");
  assert.equal(view.summary.shifts_total, 2);
  // SH-1 与核准的 06-04 00:00-08:00 重叠，SH-2 落在年假排除日
  const [sh1, sh2] = view.schedule_impact;
  assert.equal(sh1.coverage, "covered_by_approved_leave");
  assert.equal(sh2.coverage, "not_covered");
  assert.deepEqual(view.approved_days, ["2025-06-03", "2025-06-04", "2025-06-05"]);

  // 视图中不得出现证据链字段
  const text = JSON.stringify(view);
  for (const forbidden of ["proof", "excluded", "diagnosis", "证明", "诊断", "leave_type"]) {
    assert.ok(!text.includes(forbidden), `主管视图不应包含 ${forbidden}`);
  }
});

test("薪酬人员只看已核准区间与差额", () => {
  const { store, claimA } = decidedScenario();
  const view = payrollView(store, claimA.claim_id);
  assert.equal(view.leave_type, "care_leave");
  assert.equal(view.totals.counted_hours, 14);
  assert.equal(view.approved_intervals.length, 3);
  const text = JSON.stringify(view);
  for (const forbidden of ["proof_pins", "excluded", "signature", "diagnosis", "诊断"]) {
    assert.ok(!text.includes(forbidden), `薪酬视图不应包含 ${forbidden}`);
  }
});

test("争议处理人须持有效授权查看证据链", () => {
  const { store, claimA } = decidedScenario();
  assert.throws(() => disputeView(store, "CASE-ICU-12D", "LAW-01"), /授权/);

  grantAccess(
    store,
    { case_id: "CASE-ICU-12D", grantee: "LAW-01", purpose: "劳动争议调解", expires_at: "2026-01-01T00:00:00+08:00" },
    NOW,
  );
  const view = disputeView(store, "CASE-ICU-12D", "LAW-01", NOW);
  assert.equal(view.authorization.grantee, "LAW-01");
  assert.equal(view.proofs.length, 2);
  assert.equal(view.claims.length, 2);
  assert.equal(view.decisions.length, 2);
  assert.ok(view.proofs.every((proof) => proof.signature));

  // 授权过期后再次拒绝
  assert.throws(
    () => disputeView(store, "CASE-ICU-12D", "LAW-01", "2026-06-01T00:00:00+08:00"),
    /授权/,
  );
  assert.ok(claimA.claim_id);
});

test("员工可预览向各角色披露的字段，且不含诊断", () => {
  const { store, claimA } = decidedScenario();
  const supervisor = disclosurePreview(store, claimA.claim_id, "supervisor");
  const payroll = disclosurePreview(store, claimA.claim_id, "payroll");
  const dispute = disclosurePreview(store, claimA.claim_id, "dispute_handler");

  // 主管预览只含排班字段，争议预览包含证据链
  const supervisorPaths = supervisor.disclosed_fields.map((field) => field.path);
  assert.ok(supervisorPaths.some((path) => path.startsWith("schedule_impact")));
  assert.ok(!supervisorPaths.some((path) => path.includes("proof")));
  const disputePaths = dispute.disclosed_fields.map((field) => field.path);
  assert.ok(disputePaths.some((path) => path.startsWith("proofs")));

  // 预览与实际视图内容一致
  const view = supervisorView(store, claimA.claim_id);
  assert.equal(
    supervisor.disclosed_fields.find((field) => field.path === "decision_status").value,
    view.decision_status,
  );

  for (const preview of [supervisor, payroll, dispute]) {
    const text = JSON.stringify(preview.disclosed_fields);
    assert.ok(!text.includes("诊断"), "披露预览不得包含诊断信息");
    assert.ok(preview.guarantees.length >= 3);
  }
});

test("未知披露对象被拒绝", () => {
  const { store, claimA } = decidedScenario();
  assert.throws(() => disclosurePreview(store, claimA.claim_id, "everyone"), /未知披露对象/);
});
