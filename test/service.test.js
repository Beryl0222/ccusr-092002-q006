import assert from "node:assert/strict";
import test from "node:test";

import { generateSigningKeyPair, IssuerRegistry } from "../src/domain/credentials.js";
import {
  approveClaim,
  issueIcuCertificate,
  newService,
  registerHospital,
  registerWitness,
  standardEmployee,
} from "./helpers.js";

const baseInput = {
  declarations: {
    care: [{ start: "2025-06-02T08:00:00+08:00", end: "2025-06-04T08:30:00+08:00", mode: "on_site" }],
  },
  annual_leave: [{ start: "2025-06-03T00:00:00+08:00", end: "2025-06-04T00:00:00+08:00" }],
};

test("端到端：预览不含诊断 → 受理 → 草稿 → 提交 → 核准", () => {
  const svc = newService();
  const hospital = registerHospital(svc);
  standardEmployee(svc);
  const cert = issueIcuCertificate(hospital);

  const preview = svc.previewCertificate(cert);
  assert.equal(preview.verified, true);
  assert.ok(preview.disclosure.some((d) => d.field === "facts.care_window"));
  assert.ok(!JSON.stringify(preview).includes("diagnosis"));

  svc.submitCertificate("E001", cert);
  const claim = svc.createClaim("E001", baseInput);
  assert.equal(claim.status, "draft");
  assert.ok(claim.evaluation.segments.length >= 2);
  svc.submitClaim(claim.id);
  const approved = svc.reviewClaim(claim.id, { action: "approved", reviewer: "hr-li" });
  assert.equal(approved.status, "approved");
  assert.equal(approved.decision.reviewer, "hr-li");
});

test("凭证验签失败时拒绝受理", () => {
  const svc = newService();
  registerHospital(svc);
  standardEmployee(svc);
  // 使用一个未在服务名录中注册的签发方。
  const keys = generateSigningKeyPair();
  const unregistered = new IssuerRegistry({
    id: "H-UNREGISTERED",
    name: "未注册医院",
    kind: "hospital",
    ...keys,
  });
  const envelope = issueIcuCertificate(unregistered);
  assert.throws(
    () => svc.submitCertificate("E001", envelope),
    /unknown_issuer|凭证核验失败/,
  );
});

test("医院更正只产生新版本与差额调整，复核后薪酬按最新版本", () => {
  const svc = newService();
  const hospital = registerHospital(svc);
  standardEmployee(svc);
  const certV1 = issueIcuCertificate(hospital);
  svc.submitCertificate("E001", certV1);
  const claim = svc.createClaim("E001", baseInput);
  approveClaim(svc, claim.id);
  const payrollBefore = svc.payrollView().approved_intervals.reduce((sum, i) => sum + i.pay_amount, 0);
  assert.ok(payrollBefore > 0);

  const certV2 = svc.issuerSupersede("HOSP-CENTRAL", certV1.payload.certificate_id, {
    care_window: { start: "2025-06-02T00:00:00+08:00", end: "2025-06-04T00:00:00+08:00" },
    icu_window: { start: "2025-06-02T00:00:00+08:00", end: "2025-06-04T00:00:00+08:00" },
    events: [
      { ref: "EVT-A", kind: "admission", occurred_at: "2025-06-02T01:20:00+08:00" },
      { ref: "EVT-N", kind: "critical_notice", occurred_at: "2025-06-03T02:14:00+08:00" },
    ],
  }, "转出ICU");
  const { adjustment } = svc.applyCertificateCorrection(claim.id, "E001", certV2, {
    reason: "院方更正：6月4日转出ICU",
  });
  assert.equal(adjustment.delta_amount < 0, true);
  assert.equal(adjustment.status, "pending_review");

  // 复核前：差额未过账，薪酬仍只看最近核准版本（v1）。
  assert.equal(svc.payrollView().adjustments.length, 0);
  svc.reviewClaim(claim.id, { action: "approved", reviewer: "hr-li", reason: "更正属实" });
  const payroll = svc.payrollView();
  const posted = payroll.adjustments.find((a) => a.id === adjustment.id);
  assert.equal(posted.status, "posted");
  const versions = new Set(payroll.approved_intervals.map((i) => i.version));
  assert.deepEqual([...versions], [2]); // 不存在 v1/v2 双重计薪

  // 调整可复原：制度、凭证状态、排除重叠、最终决定齐备。
  const trace = svc.traceAdjustment(adjustment.id);
  assert.ok(trace.policy_basis.some((p) => p.policy_id === "POL-2025"));
  assert.equal(trace.versions[1].certificates[0].version, 2);
  assert.equal(trace.versions[1].certificates[0].status, "active");
  assert.ok(trace.versions[1].excluded_overlaps.some((e) => e.reason === "annual_leave_overlap"));
  assert.equal(trace.final_review.action, "approved");
});

test("驳回更正则差额作废，维持原核准", () => {
  const svc = newService();
  const hospital = registerHospital(svc);
  standardEmployee(svc);
  const certV1 = issueIcuCertificate(hospital);
  svc.submitCertificate("E001", certV1);
  const claim = svc.createClaim("E001", baseInput);
  approveClaim(svc, claim.id);
  const certV2 = svc.issuerSupersede("HOSP-CENTRAL", certV1.payload.certificate_id, {
    care_window: { start: "2025-06-02T00:00:00+08:00", end: "2025-06-04T00:00:00+08:00" },
    icu_window: { start: "2025-06-02T00:00:00+08:00", end: "2025-06-04T00:00:00+08:00" },
    events: [{ ref: "EVT-A", kind: "admission", occurred_at: "2025-06-02T01:20:00+08:00" }],
  }, "更正");
  const { adjustment } = svc.applyCertificateCorrection(claim.id, "E001", certV2);
  svc.reviewClaim(claim.id, { action: "rejected", reviewer: "hr-li", reason: "更正依据不足" });
  assert.equal(adjustment.status, "voided");
  // 薪酬仍按 v1。
  assert.deepEqual(
    [...new Set(svc.payrollView().approved_intervals.map((i) => i.version))],
    [1],
  );
});

test("劳动仲裁结果即时过账，授予片段按裁决计薪", () => {
  const svc = newService();
  const hospital = registerHospital(svc);
  standardEmployee(svc);
  // 凭证窗口在班次开始前截止：班内 08:00 之后原本无支持，按事假计 0。
  const envelope = issueIcuCertificate(hospital, {
    window: { start: "2025-06-04T00:00:00+08:00", end: "2025-06-04T08:00:00+08:00" },
    events: [{ ref: "EVT-A", kind: "admission", occurred_at: "2025-06-04T01:00:00+08:00" }],
  });
  svc.submitCertificate("E001", envelope);
  const claim = svc.createClaim("E001", {
    declarations: {
      care: [{ start: "2025-06-04T08:00:00+08:00", end: "2025-06-04T08:30:00+08:00", mode: "on_site" }],
    },
  });
  approveClaim(svc, claim.id);
  const before = svc.payrollView().approved_intervals.reduce((sum, i) => sum + i.pay_amount, 0);
  assert.equal(before, 0);

  const { adjustment } = svc.recordArbitration(claim.id, {
    case_no: "ARB-2025-009",
    outcome: "uphold",
    reason: "裁决支持6月4日上午4小时",
    granted_intervals: [{ start: "2025-06-04T08:00:00+08:00", end: "2025-06-04T12:00:00+08:00" }],
    reviewer: "arbiter-wang",
  });
  assert.equal(adjustment.status, "posted");
  assert.equal(adjustment.delta_amount, 200);
  const trace = svc.traceAdjustment(adjustment.id);
  assert.equal(trace.final_review.reviewer, "arbiter-wang");
});

test("亲属轮换：同患者重叠申报挂起，仲裁后解除挂起", () => {
  const svc = newService();
  const hospital = registerHospital(svc);
  standardEmployee(svc, "E001");
  svc.addEmployee({
    id: "E002",
    name: "员工E002",
    manager_id: "M01",
    hourly_rate: 40,
    shifts: [{ id: "T1", start: "2025-06-02T08:00:00+08:00", end: "2025-06-02T20:00:00+08:00" }],
  });
  svc.submitCertificate("E001", issueIcuCertificate(hospital, { subjectCode: "E001|REL-1" }));
  const claim1 = svc.createClaim("E001", {
    declarations: {
      care: [{ start: "2025-06-02T08:00:00+08:00", end: "2025-06-02T20:00:00+08:00", mode: "on_site" }],
    },
  });
  approveClaim(svc, claim1.id);

  svc.submitCertificate("E002", issueIcuCertificate(hospital, { subjectCode: "E002|REL-2", relationship: "spouse" }));
  const claim2 = svc.createClaim("E002", {
    declarations: {
      care: [{ start: "2025-06-02T12:00:00+08:00", end: "2025-06-02T20:00:00+08:00", mode: "on_site" }],
    },
  });
  assert.equal(claim2.evaluation.segments.every((s) => s.relay_pending), true);
  assert.equal(claim2.evaluation.totals.payable_amount, 0);

  // 仲裁把重叠时段裁给 E002。
  svc.recordArbitration(claim2.id, {
    case_no: "ARB-REL-1",
    outcome: "uphold",
    granted_intervals: [{ start: "2025-06-02T12:00:00+08:00", end: "2025-06-02T20:00:00+08:00" }],
  });
  const payable = svc.payrollView().approved_intervals.filter((i) => i.employee_id === "E002");
  assert.ok(payable.some((i) => i.pay_amount > 0));
});

test("角色视图：主管只见排班影响，薪酬只见核准区间", () => {
  const svc = newService();
  const hospital = registerHospital(svc);
  standardEmployee(svc);
  svc.submitCertificate("E001", issueIcuCertificate(hospital));
  const claim = svc.createClaim("E001", baseInput);
  approveClaim(svc, claim.id);

  const manager = svc.managerView("M01");
  const row = manager.claims.find((c) => c.claim_id === claim.id);
  assert.ok(row.roster_impact.shifts.length >= 1);
  const managerJson = JSON.stringify(manager);
  for (const forbidden of ["certificate_id", "pay_amount", "CRT-", "patient_ref"]) {
    assert.ok(!managerJson.includes(forbidden), `主管视图不得包含 ${forbidden}`);
  }

  const payroll = svc.payrollView();
  assert.ok(payroll.approved_intervals.every((i) => typeof i.pay_amount === "number"));
  const payrollJson = JSON.stringify(payroll);
  for (const forbidden of ["event_refs", "facts", "icu_window"]) {
    assert.ok(!payrollJson.includes(forbidden), `薪酬视图不得包含 ${forbidden}`);
  }
});

test("证据链须经授权，访问留痕", () => {
  const svc = newService();
  const hospital = registerHospital(svc);
  standardEmployee(svc);
  svc.submitCertificate("E001", issueIcuCertificate(hospital));
  const claim = svc.createClaim("E001", baseInput);
  approveClaim(svc, claim.id);

  assert.throws(() => svc.evidenceChain(claim.id, { viewer: "arbiter-wang" }), /未经授权/);
  svc.grantEvidenceAccess(claim.id, {
    grantee: "arbiter-wang",
    granted_by: "union",
    expires_at: "2025-06-20T00:00:00+08:00",
  });
  const chain = svc.evidenceChain(claim.id, { viewer: "arbiter-wang" });
  assert.equal(chain.versions.length, 1);
  assert.equal(svc.accessLog.length, 1);
  assert.equal(svc.accessLog[0].viewer, "arbiter-wang");

  // 过期授权失效。
  const expiredGrant = svc.grants[svc.grants.length - 1];
  expiredGrant.expires_at = "2025-06-01T00:00:00+08:00";
  assert.throws(() => svc.evidenceChain(claim.id, { viewer: "arbiter-wang" }), /未经授权/);
});

test("见证方可签发远程手续凭证，支持远程办公分类", () => {
  const svc = newService();
  registerWitness(svc);
  svc.addEmployee({
    id: "E009",
    name: "员工E009",
    manager_id: "M01",
    hourly_rate: 60,
    shifts: [{ id: "S1", start: "2025-06-10T09:00:00+08:00", end: "2025-06-10T18:00:00+08:00" }],
  });
  const envelope = svc.requireIssuer("WIT-LEGAL").issue({
    subjectPseudonym: "F-WIT-1",
    patientRef: "PAT-9",
    relationship: "sibling",
    facts: {
      care_window: { start: "2025-06-10T00:00:00+08:00", end: "2025-06-11T00:00:00+08:00" },
      events: [
        { ref: "EVT-D", kind: "document_handling", presence: "remote", occurred_at: "2025-06-10T10:00:00+08:00" },
      ],
    },
    now: "2025-06-10T10:00:00+08:00",
  });
  svc.submitCertificate("E009", envelope);
  const claim = svc.createClaim("E009", {
    declarations: {
      care: [{ start: "2025-06-10T10:00:00+08:00", end: "2025-06-10T12:00:00+08:00", mode: "remote" }],
    },
  });
  assert.equal(claim.evaluation.segments[0].leave_kind, "remote_work");
});
