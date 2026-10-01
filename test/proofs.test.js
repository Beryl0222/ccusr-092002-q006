import assert from "node:assert/strict";
import test from "node:test";

import {
  correctProof,
  issueProof,
  registerIssuer,
  verifyProof,
} from "../src/lib/proofs.js";
import { createStore } from "../src/lib/store.js";
import { HOSPITAL_COVERAGE, NOW } from "./helpers.js";

function setup() {
  const store = createStore();
  registerIssuer(store, { issuer_id: "HOSP-01", kind: "hospital", key: "hosp-key" });
  return store;
}

function issueInput(extra = {}) {
  return {
    issuer_id: "HOSP-01",
    issuer_key: "hosp-key",
    case_id: "CASE-ICU-12D",
    subject_employee_id: "EMP-1001",
    coverage: HOSPITAL_COVERAGE,
    valid_until: "2025-12-31T23:59:59+08:00",
    ...extra,
  };
}

test("签发后可验真伪与有效期", () => {
  const store = setup();
  const { proof } = issueProof(store, issueInput(), NOW);
  const result = verifyProof(store, proof.proof_id, NOW);
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks, {
    issuer_known: true,
    signature_valid: true,
    within_validity: true,
    status_active: true,
  });
});

test("密钥不匹配与未知签发方被拒绝", () => {
  const store = setup();
  assert.throws(() => issueProof(store, issueInput({ issuer_key: "wrong" }), NOW), /密钥不匹配/);
  assert.throws(() => issueProof(store, issueInput({ issuer_id: "NOPE" }), NOW), /未知签发方/);
});

test("证明不得包含诊断类信息", () => {
  const store = setup();
  assert.throws(
    () =>
      issueProof(
        store,
        issueInput({ coverage: [{ kind: "诊断证明", start: "2025-06-03T00:00:00+08:00", end: "2025-06-04T00:00:00+08:00" }] }),
        NOW,
      ),
    /诊断/,
  );
});

test("重复上传幂等，不增加证明数量", () => {
  const store = setup();
  const first = issueProof(store, issueInput(), NOW);
  const second = issueProof(store, issueInput(), NOW);
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.proof.proof_id, first.proof.proof_id);
  assert.equal(store.proofs.size, 1);
});

test("更正产生新版本，旧版本失效并指向最新版本", () => {
  const store = setup();
  const { proof: v1 } = issueProof(store, issueInput(), NOW);
  const { proof: v2 } = correctProof(
    store,
    v1.proof_id,
    {
      issuer_key: "hosp-key",
      coverage: [{ kind: "hospitalization", start: "2025-06-03T02:14:00+08:00", end: "2025-06-12T10:00:00+08:00" }],
    },
    NOW,
  );
  assert.equal(v2.version, 2);
  assert.equal(v2.supersedes, v1.proof_id);

  const oldCheck = verifyProof(store, v1.proof_id, NOW);
  assert.equal(oldCheck.ok, false);
  assert.equal(oldCheck.checks.status_active, false);
  assert.equal(oldCheck.latest_version_id, v2.proof_id);

  const newCheck = verifyProof(store, v2.proof_id, NOW);
  assert.equal(newCheck.ok, true);
});

test("内容不变的更正被拒绝", () => {
  const store = setup();
  const { proof: v1 } = issueProof(store, issueInput(), NOW);
  assert.throws(
    () => correctProof(store, v1.proof_id, { issuer_key: "hosp-key" }, NOW),
    /无需新版本/,
  );
});

test("超出有效期后核验不通过", () => {
  const store = setup();
  const { proof } = issueProof(store, issueInput(), NOW);
  const result = verifyProof(store, proof.proof_id, "2026-06-01T00:00:00+08:00");
  assert.equal(result.ok, false);
  assert.equal(result.checks.within_validity, false);
});
