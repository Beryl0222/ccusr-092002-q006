import assert from "node:assert/strict";
import test from "node:test";

import { createServer } from "../src/service.js";
import { bootstrapDemo } from "../src/bootstrap.js";
import { issueIcuCertificate } from "./helpers.js";

async function withServer(run) {
  const demo = bootstrapDemo();
  const server = createServer({ context: demo.context });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await run({ base, ...demo });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function call(base, token, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}

test("健康检查无需令牌，业务接口需要鉴权", async () => {
  await withServer(async ({ base }) => {
    const health = await call(base, null, "GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.service, "icu-family-evidence");

    assert.equal((await call(base, null, "GET", "/payroll")).status, 401);
    assert.equal(
      (await call(base, "tok-employee-e001", "GET", "/payroll")).status,
      403,
    );
    assert.equal(
      (await call(base, "tok-employee-e002", "GET", "/employees/E001/claims")).status,
      403,
    );
  });
});

test("员工不能越权访问他人数据", async () => {
  await withServer(async ({ base }) => {
    const res = await call(base, "tok-employee-e002", "GET", "/employees/E001/claims");
    assert.equal(res.status, 403);
  });
});

test("完整 API 流程：签发→预览→受理→申请→核准→主管/薪酬视图", async () => {
  await withServer(async ({ base, issuers, service }) => {
    // 医院签发（演示中直接通过注册簿）。
    const cert = issueIcuCertificate(issuers.hospital, { now: service.now() });

    // 员工先预览披露字段。
    const preview = await call(
      base,
      "tok-employee-e001",
      "POST",
      "/employees/E001/certificates/preview",
      { certificate_envelope: cert },
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.json.verified, true);
    assert.ok(preview.json.disclosure.some((d) => d.field === "facts.care_window"));
    assert.ok(!JSON.stringify(preview.json).includes("diagnosis"));

    // 受理。
    const submitted = await call(
      base,
      "tok-employee-e001",
      "POST",
      "/employees/E001/certificates",
      { certificate_envelope: cert },
    );
    assert.equal(submitted.status, 200);
    assert.equal(submitted.json.status, "active");

    // 建申请、提交。
    const claimBody = {
      declarations: {
        care: [{ start: "2025-06-02T08:00:00+08:00", end: "2025-06-04T08:30:00+08:00", mode: "on_site" }],
        standby: [{ start: "2025-06-04T20:00:00+08:00", end: "2025-06-05T02:00:00+08:00" }],
      },
      annual_leave: [{ start: "2025-06-03T00:00:00+08:00", end: "2025-06-04T00:00:00+08:00" }],
    };
    const created = await call(base, "tok-employee-e001", "POST", "/employees/E001/claims", claimBody);
    assert.equal(created.status, 200);
    const claimId = created.json.id;
    assert.equal(created.json.status, "draft");
    assert.ok(created.json.evaluation.segments.some((s) => s.leave_kind === "icu_care_leave"));
    assert.ok(created.json.evaluation.exclusions.some((e) => e.reason === "annual_leave_overlap"));

    assert.equal((await call(base, "tok-employee-e001", "POST", `/claims/${claimId}/submit`)).status, 200);

    // HR 队列可见，员工不可见。
    const queue = await call(base, "tok-hr", "GET", "/hr/queue");
    assert.equal(queue.status, 200);
    assert.ok(queue.json.queue.some((item) => item.claim_id === claimId));
    assert.equal((await call(base, "tok-employee-e001", "GET", "/hr/queue")).status, 403);

    // HR 核准。
    const review = await call(base, "tok-hr", "POST", `/claims/${claimId}/review`, {
      action: "approved",
      reason: "凭证齐全",
    });
    assert.equal(review.status, 200);
    assert.equal(review.json.status, "approved");

    // 主管只见排班影响。
    const roster = await call(base, "tok-manager-m01", "GET", "/managers/M01/roster");
    assert.equal(roster.status, 200);
    const row = roster.json.claims.find((item) => item.claim_id === claimId);
    assert.ok(row.roster_impact.shifts.length >= 1);
    assert.ok(!JSON.stringify(row).includes("certificate_id"));
    assert.ok(!JSON.stringify(row).includes("pay_amount"));

    // 薪酬只见核准区间。
    const payroll = await call(base, "tok-payroll", "GET", "/payroll");
    assert.ok(payroll.json.approved_intervals.some((item) => item.claim_id === claimId));
    assert.ok(!JSON.stringify(payroll.json).includes("icu_window"));
  });
});

test("医院更正经 API 产生差额，薪酬可复原调整链路", async () => {
  await withServer(async ({ base, issuers, service }) => {
    const certV1 = issueIcuCertificate(issuers.hospital, { now: service.now() });
    await call(base, "tok-employee-e001", "POST", "/employees/E001/certificates", {
      certificate_envelope: certV1,
    });
    const created = await call(base, "tok-employee-e001", "POST", "/employees/E001/claims", {
      declarations: {
        care: [{ start: "2025-06-02T08:00:00+08:00", end: "2025-06-04T08:30:00+08:00", mode: "on_site" }],
      },
    });
    const claimId = created.json.id;
    await call(base, "tok-employee-e001", "POST", `/claims/${claimId}/submit`);
    await call(base, "tok-hr", "POST", `/claims/${claimId}/review`, { action: "approved" });

    const certV2 = service.issuerSupersede("HOSP-CENTRAL", certV1.payload.certificate_id, {
      care_window: { start: "2025-06-02T00:00:00+08:00", end: "2025-06-04T00:00:00+08:00" },
      icu_window: { start: "2025-06-02T00:00:00+08:00", end: "2025-06-04T00:00:00+08:00" },
      events: [
        { ref: "EVT-A", kind: "admission", occurred_at: "2025-06-02T01:20:00+08:00" },
        { ref: "EVT-N", kind: "critical_notice", occurred_at: "2025-06-03T02:14:00+08:00" },
      ],
    }, "转出ICU");
    const correction = await call(base, "tok-employee-e001", "POST", `/claims/${claimId}/corrections`, {
      certificate_envelope: certV2,
      reason: "院方更正",
    });
    assert.equal(correction.status, 200);
    assert.equal(correction.json.adjustment.status, "pending_review");

    // 复核前薪酬看不到该调整。
    assert.equal((await call(base, "tok-payroll", "GET", "/payroll")).json.adjustments.length, 0);
    await call(base, "tok-hr", "POST", `/claims/${claimId}/review`, { action: "approved", reason: "确认" });

    const payroll = await call(base, "tok-payroll", "GET", "/payroll");
    const adjustment = payroll.json.adjustments[0];
    assert.equal(adjustment.status, "posted");
    assert.ok(adjustment.delta_amount < 0);

    // 从调整复原制度、凭证状态、排除重叠、最终决定。
    const trace = await call(base, "tok-payroll", "GET", `/adjustments/${adjustment.id}/trace`);
    assert.equal(trace.status, 200);
    assert.ok(trace.json.policy_basis.some((p) => p.policy_id === "POL-2025"));
    assert.equal(trace.json.versions[1].certificates[0].version, 2);
    assert.equal(trace.json.final_review.action, "approved");
  });
});

test("争议处理人须授权才能查看证据链", async () => {
  await withServer(async ({ base, issuers, service }) => {
    const cert = issueIcuCertificate(issuers.hospital, { now: service.now() });
    await call(base, "tok-employee-e001", "POST", "/employees/E001/certificates", {
      certificate_envelope: cert,
    });
    const created = await call(base, "tok-employee-e001", "POST", "/employees/E001/claims", {
      declarations: {
        care: [{ start: "2025-06-02T08:00:00+08:00", end: "2025-06-02T20:00:00+08:00", mode: "on_site" }],
      },
    });
    const claimId = created.json.id;

    assert.equal(
      (await call(base, "tok-arbitrator", "GET", `/claims/${claimId}/evidence`)).status,
      403,
    );
    // 授权由 HR（代表工会/授权方）授予，争议处理人不能自行授权。
    assert.equal(
      (await call(base, "tok-arbitrator", "POST", `/claims/${claimId}/evidence-grants`, {
        grantee: "arbiter-wang",
      })).status,
      403,
    );
    const grant = await call(base, "tok-hr", "POST", `/claims/${claimId}/evidence-grants`, {
      grantee: "arbiter-wang",
      expires_at: "2025-06-20T00:00:00+08:00",
    });
    assert.equal(grant.status, 200);

    const chain = await call(base, "tok-arbitrator", "GET", `/claims/${claimId}/evidence`);
    assert.equal(chain.status, 200);
    assert.equal(chain.json.versions.length, 1);
    assert.ok(chain.json.certificates.length >= 1);

    // 主管与薪酬都不能访问证据链。
    assert.equal((await call(base, "tok-manager-m01", "GET", `/claims/${claimId}/evidence`)).status, 403);
    assert.equal((await call(base, "tok-payroll", "GET", `/claims/${claimId}/evidence`)).status, 403);
  });
});
