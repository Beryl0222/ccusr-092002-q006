import assert from "node:assert/strict";
import test from "node:test";

import { createServer, healthPayload, serviceId } from "../src/service.js";

async function startServer() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    async stop() {
      server.closeAllConnections(); // fetch 的 keep-alive 连接需显式断开
      await new Promise((resolve) => server.close(resolve));
    },
    async call(method, path, body, headers = {}) {
      const response = await fetch(base + path, {
        method,
        headers: { "content-type": "application/json", connection: "close", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    },
  };
}

test("健康检查与未知路由", async () => {
  const { call, stop } = await startServer();
  const health = await call("GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.data.service, serviceId);
  const missing = await call("GET", "/nope");
  assert.equal(missing.status, 404);
  assert.equal(healthPayload().service, serviceId);
  await stop();
});

test("端到端：签发→申报→核准→更正→仲裁→视图→预览→复原", async () => {
  const { call, stop } = await startServer();

  // 1. 登记签发方并签发两名亲属的证明
  await call("POST", "/issuers", { issuer_id: "HOSP-01", kind: "hospital", key: "hosp-key" });
  const coverage = [
    { kind: "hospitalization", start: "2025-06-03T02:14:00+08:00", end: "2025-06-15T10:00:00+08:00" },
  ];
  const proofA = (
    await call("POST", "/proofs", {
      issuer_id: "HOSP-01",
      issuer_key: "hosp-key",
      case_id: "CASE-ICU-12D",
      subject_employee_id: "EMP-1001",
      coverage,
      valid_until: "2027-12-31T23:59:59+08:00",
    })
  ).data.proof;
  const proofB = (
    await call("POST", "/proofs", {
      issuer_id: "HOSP-01",
      issuer_key: "hosp-key",
      case_id: "CASE-ICU-12D",
      subject_employee_id: "EMP-1002",
      coverage,
      valid_until: "2027-12-31T23:59:59+08:00",
    })
  ).data.proof;

  // 重复上传同一份证明：幂等返回原证明
  const dup = await call("POST", "/proofs", {
    issuer_id: "HOSP-01",
    issuer_key: "hosp-key",
    case_id: "CASE-ICU-12D",
    subject_employee_id: "EMP-1001",
    coverage,
    valid_until: "2027-12-31T23:59:59+08:00",
  });
  assert.equal(dup.data.deduplicated, true);
  assert.equal(dup.data.proof.proof_id, proofA.proof_id);

  // 2. 核验真伪
  const verify = await call("GET", `/proofs/${proofA.proof_id}/verify`);
  assert.equal(verify.data.ok, true);

  // 3. 两名亲属申报
  const claimA = (
    await call("POST", "/claims", {
      case_id: "CASE-ICU-12D",
      employee_id: "EMP-1001",
      proof_ids: [proofA.proof_id],
      care_periods: [
        { start: "2025-06-03T20:00:00+08:00", end: "2025-06-04T08:00:00+08:00", modality: "standby" },
        { start: "2025-06-05T14:00:00+08:00", end: "2025-06-05T18:00:00+08:00", modality: "remote_procedure" },
        { start: "2025-06-06T09:00:00+08:00", end: "2025-06-06T17:00:00+08:00", modality: "standby" },
      ],
      annual_leave: [{ start: "2025-06-06T00:00:00+08:00", end: "2025-06-07T00:00:00+08:00" }],
      shifts: [
        { shift_id: "SH-1", start: "2025-06-04T00:00:00+08:00", end: "2025-06-04T08:00:00+08:00" },
      ],
      filed_at: "2025-06-16T09:00:00+08:00",
    })
  ).data;
  const claimB = (
    await call("POST", "/claims", {
      case_id: "CASE-ICU-12D",
      employee_id: "EMP-1002",
      proof_ids: [proofB.proof_id],
      care_periods: [
        { start: "2025-06-04T06:00:00+08:00", end: "2025-06-04T10:00:00+08:00", modality: "standby" },
      ],
      filed_at: "2025-06-17T09:00:00+08:00",
    })
  ).data;

  // 4. 核准
  const decisionA = (
    await call("POST", `/claims/${claimA.claim_id}/decisions`, { reviewer: "HR-7" })
  ).data;
  assert.equal(decisionA.totals.counted_hours, 14);
  const decisionB = (
    await call("POST", `/claims/${claimB.claim_id}/decisions`, { reviewer: "HR-7" })
  ).data;
  assert.equal(decisionB.totals.counted_hours, 2);

  // 5. 医院更正 → 新版本 + 差额调整
  const correction = (
    await call("POST", `/proofs/${proofA.proof_id}/corrections`, {
      issuer_key: "hosp-key",
      coverage: [
        { kind: "hospitalization", start: "2025-06-04T04:00:00+08:00", end: "2025-06-15T10:00:00+08:00" },
      ],
    })
  ).data;
  assert.equal(correction.proof.version, 2);
  assert.equal(correction.adjustments.length, 1);
  assert.equal(correction.adjustments[0].delta_hours, -8);

  // 6. 劳动仲裁 → 恢复轮换重叠
  const arbitration = (
    await call("POST", "/cases/CASE-ICU-12D/arbitrations", {
      reinstate_reasons: ["rotation_overlap"],
      note: "双亲属夜间共同待命属实",
    })
  ).data;
  assert.equal(arbitration.adjustments.length, 1);
  assert.equal(arbitration.adjustments[0].delta_hours, 2);

  // 7. 角色视图
  const supervisor = (await call("GET", `/claims/${claimA.claim_id}/views/supervisor`)).data;
  assert.equal(supervisor.summary.shifts_covered, 1);
  assert.ok(!JSON.stringify(supervisor).includes("proof"));

  const payroll = (await call("GET", `/claims/${claimA.claim_id}/views/payroll`)).data;
  assert.equal(payroll.approved_intervals.length > 0, true);

  const forbidden = await call("GET", "/cases/CASE-ICU-12D/views/dispute");
  assert.equal(forbidden.status, 403);
  await call("POST", "/cases/CASE-ICU-12D/authorizations", {
    grantee: "LAW-01",
    purpose: "劳动争议调解",
    expires_at: "2027-01-01T00:00:00+08:00",
  });
  const dispute = await call("GET", "/cases/CASE-ICU-12D/views/dispute", undefined, {
    "x-grantee": "LAW-01",
  });
  assert.equal(dispute.status, 200);
  assert.equal(dispute.data.proofs.length, 3); // proofA 两个版本 + proofB
  assert.ok(dispute.data.timeline.events.length >= 3);

  // 8. 员工预览披露字段
  const preview = (
    await call("GET", `/claims/${claimA.claim_id}/disclosure-preview?audience=supervisor`)
  ).data;
  assert.ok(preview.disclosed_fields.length > 0);
  assert.ok(!JSON.stringify(preview.disclosed_fields).includes("诊断"));

  // 9. 薪资调整与审计复原
  const payrollPost = (
    await call("POST", "/payroll-adjustments", {
      period: "2025-06",
      amount_delta: -960,
      adjustment_ids: correction.adjustments.map((a) => a.adjustment_id),
    })
  ).data;
  const reconstruction = (
    await call("GET", `/payroll-adjustments/${payrollPost.payroll_adjustment_id}/reconstruction`)
  ).data;
  const block = reconstruction.claims[0];
  assert.equal(block.policy.version, 1);
  assert.equal(block.credentials[0].version, 2);
  assert.ok(block.excluded_overlaps.length > 0);
  assert.ok(block.final_review.reviewer);
  assert.deepEqual(
    block.decision_chain.map((entry) => entry.version),
    [1, 2, 3],
  );

  await stop();
});

test("非法请求得到明确错误", async () => {
  const { server, call, stop } = await startServer();
  const badJson = await fetch(
    `http://127.0.0.1:${server.address().port}/claims`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "not-json" },
  );
  assert.equal(badJson.status, 400);
  const missing = await call("POST", "/claims", { case_id: "CASE-ICU-12D" });
  assert.equal(missing.status, 400);
  const noClaim = await call("GET", "/claims/CLM-9999/views/supervisor");
  assert.equal(noClaim.status, 404);
  await stop();
});
