import assert from "node:assert/strict";
import test from "node:test";

import {
  CERTIFICATE_TYP,
  disclosureFields,
  generateSigningKeyPair,
  IssuerRegistry,
  pseudonym,
  verifyCertificate,
} from "../src/domain/credentials.js";
import { splitByLocalDay, subtract, unionMerge } from "../src/domain/time.js";

const NOW = "2025-06-10T10:00:00+08:00";
const OFFSET = 480;

function hospitalRegistry() {
  const keys = generateSigningKeyPair();
  return new IssuerRegistry({ id: "H1", name: "测试医院", kind: "hospital", ...keys });
}

const facts = {
  care_window: { start: "2025-06-02T00:00:00+08:00", end: "2025-06-09T00:00:00+08:00" },
  icu_window: { start: "2025-06-02T00:00:00+08:00", end: "2025-06-09T00:00:00+08:00" },
  events: [
    { ref: "E1", kind: "admission", occurred_at: "2025-06-02T01:20:00+08:00" },
    { ref: "E2", kind: "critical_notice", occurred_at: "2025-06-03T02:14:00+08:00" },
  ],
};

test("凭证可验签且不含诊断字段", () => {
  const registry = hospitalRegistry();
  const envelope = registry.issue({
    subjectPseudonym: pseudonym("H1", "s", "FAM", "E001"),
    patientRef: "PAT-1",
    relationship: "child",
    facts,
    now: NOW,
  });
  const result = verifyCertificate(envelope, { H1: registry.directoryEntry }, { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.payload.schema, CERTIFICATE_TYP);

  const fields = disclosureFields(result.payload).map((item) => item.field);
  for (const forbidden of ["diagnosis", "diagnoses", "medical_record", "treatment", "lab", "medication"]) {
    assert.ok(!fields.includes(forbidden), `凭证不得披露 ${forbidden}`);
  }
  const serialized = JSON.stringify(envelope);
  for (const forbidden of ["diagnosis", "病历", "诊断"]) {
    assert.ok(!serialized.includes(forbidden));
  }
});

test("篡改负载即验签失败", () => {
  const registry = hospitalRegistry();
  const envelope = registry.issue({
    subjectPseudonym: "F-1", patientRef: "P", relationship: "child", facts, now: NOW,
  });
  const tampered = JSON.parse(JSON.stringify(envelope));
  tampered.payload.facts.icu_window.end = "2025-07-01T00:00:00+08:00";
  const result = verifyCertificate(tampered, { H1: registry.directoryEntry }, { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "bad_signature");
});

test("未知签发方、过期凭证被拒绝", () => {
  const registry = hospitalRegistry();
  const envelope = registry.issue({
    subjectPseudonym: "F-1", patientRef: "P", relationship: "child", facts, validDays: 1, now: NOW,
  });
  assert.equal(
    verifyCertificate(envelope, {}, { now: NOW }).reason,
    "unknown_issuer",
  );
  assert.equal(
    verifyCertificate(envelope, { H1: registry.directoryEntry }, { now: "2025-06-20T10:00:00+08:00" }).reason,
    "expired",
  );
});

test("医院更正只产生新版本：旧版 superseded、新版可验签", () => {
  const registry = hospitalRegistry();
  const v1 = registry.issue({
    subjectPseudonym: "F-1", patientRef: "P", relationship: "child", facts, now: NOW,
  });
  const v2 = registry.supersede(v1.payload.certificate_id, {
    facts: {
      ...facts,
      icu_window: { start: "2025-06-02T00:00:00+08:00", end: "2025-06-04T00:00:00+08:00" },
      care_window: { start: "2025-06-02T00:00:00+08:00", end: "2025-06-04T00:00:00+08:00" },
    },
    now: NOW,
    reason: "转出ICU",
  });
  assert.equal(v2.payload.version, 2);
  assert.equal(v2.payload.supersedes, v1.payload.certificate_id);

  const statusV1 = registry.statusToken(v1.payload.certificate_id, { now: NOW });
  const resultV1 = verifyCertificate(v1, { H1: registry.directoryEntry }, { statusToken: statusV1, now: NOW });
  assert.equal(resultV1.ok, false);
  assert.equal(resultV1.reason, "superseded");

  const statusV2 = registry.statusToken(v2.payload.certificate_id, { now: NOW });
  assert.equal(
    verifyCertificate(v2, { H1: registry.directoryEntry }, { statusToken: statusV2, now: NOW }).ok,
    true,
  );
});

test("吊销状态通过短期状态令牌生效", () => {
  const registry = hospitalRegistry();
  const envelope = registry.issue({
    subjectPseudonym: "F-1", patientRef: "P", relationship: "child", facts, now: NOW,
  });
  registry.revoke(envelope.payload.certificate_id, { now: NOW, reason: "凭证信息有误" });
  const statusToken = registry.statusToken(envelope.payload.certificate_id, { now: NOW });
  const result = verifyCertificate(envelope, { H1: registry.directoryEntry }, { statusToken, now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "revoked");
});

test("见证方不得证明 ICU 窗口与医疗事件", () => {
  const keys = generateSigningKeyPair();
  const witness = new IssuerRegistry({ id: "W1", name: "见证方", kind: "witness", ...keys });
  assert.throws(
    () =>
      witness.issue({
        subjectPseudonym: "F-1",
        patientRef: "P",
        facts: {
          care_window: { start: "2025-06-02T00:00:00+08:00", end: "2025-06-03T00:00:00+08:00" },
          icu_window: { start: "2025-06-02T00:00:00+08:00", end: "2025-06-03T00:00:00+08:00" },
          events: [],
        },
        now: NOW,
      }),
    /见证方不得证明 ICU/,
  );
  assert.throws(
    () =>
      witness.issue({
        subjectPseudonym: "F-1",
        patientRef: "P",
        facts: {
          care_window: { start: "2025-06-02T00:00:00+08:00", end: "2025-06-03T00:00:00+08:00" },
          events: [{ kind: "admission", occurred_at: "2025-06-02T01:00:00+08:00" }],
        },
        now: NOW,
      }),
    /见证方不得证明事件类型/,
  );
  // 手续办理类事件可以由见证方证明。
  assert.doesNotThrow(() =>
    witness.issue({
      subjectPseudonym: "F-1",
      patientRef: "P",
      facts: {
        care_window: { start: "2025-06-02T00:00:00+08:00", end: "2025-06-03T00:00:00+08:00" },
        events: [
          { kind: "document_handling", presence: "remote", occurred_at: "2025-06-02T10:00:00+08:00" },
        ],
      },
      now: NOW,
    }),
  );
});

test("时间工具：跨午夜按本地日拆分、区间扣除与合并", () => {
  const pieces = splitByLocalDay(
    { start: "2025-06-03T20:00:00+08:00", end: "2025-06-04T02:00:00+08:00" },
    OFFSET,
  );
  assert.deepEqual(
    pieces.map((piece) => piece.day),
    ["2025-06-03", "2025-06-04"],
  );
  assert.equal(pieces[0].start, "2025-06-03T20:00:00+08:00");
  assert.equal(pieces[1].end, "2025-06-04T02:00:00+08:00");

  const rest = subtract(
    { start: "2025-06-03T20:00:00+08:00", end: "2025-06-04T08:00:00+08:00" },
    [{ start: "2025-06-04T00:00:00+08:00", end: "2025-06-04T06:00:00+08:00" }],
  );
  assert.equal(rest.length, 2);
  const merged = unionMerge([
    { start: "2025-06-03T20:00:00+08:00", end: "2025-06-04T02:00:00+08:00" },
    { start: "2025-06-04T01:00:00+08:00", end: "2025-06-04T08:00:00+08:00" },
  ]);
  assert.equal(merged.length, 1);
});
