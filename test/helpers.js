// 共享场景：两名亲属（EMP-1001 / EMP-1002）就同一个案 CASE-ICU-12D 申报照护假，
// 覆盖跨午夜待命、远程办理、年假重叠、重复申报、覆盖外时段与亲属轮换。
import { fileClaim } from "../src/lib/ledger.js";
import { issueProof, registerIssuer } from "../src/lib/proofs.js";
import { createStore } from "../src/lib/store.js";

export const NOW = "2025-06-20T10:00:00+08:00";
export const CASE_ID = "CASE-ICU-12D";

export const HOSPITAL_COVERAGE = [
  {
    kind: "hospitalization",
    start: "2025-06-03T02:14:00+08:00",
    end: "2025-06-15T10:00:00+08:00",
  },
];

export function buildScenario() {
  const store = createStore();
  registerIssuer(store, { issuer_id: "HOSP-01", kind: "hospital", name: "市一医院", key: "hosp-key" });
  registerIssuer(store, { issuer_id: "WIT-01", kind: "witness", name: "合规见证方", key: "wit-key" });

  const { proof: proofA } = issueProof(
    store,
    {
      issuer_id: "HOSP-01",
      issuer_key: "hosp-key",
      case_id: CASE_ID,
      subject_employee_id: "EMP-1001",
      coverage: HOSPITAL_COVERAGE,
      valid_until: "2025-12-31T23:59:59+08:00",
    },
    NOW,
  );
  const { proof: proofB } = issueProof(
    store,
    {
      issuer_id: "HOSP-01",
      issuer_key: "hosp-key",
      case_id: CASE_ID,
      subject_employee_id: "EMP-1002",
      coverage: HOSPITAL_COVERAGE,
      valid_until: "2025-12-31T23:59:59+08:00",
    },
    NOW,
  );

  const claimA = fileClaim(
    store,
    {
      case_id: CASE_ID,
      employee_id: "EMP-1001",
      proof_ids: [proofA.proof_id],
      care_periods: [
        // 跨午夜待命：06-03 20:00 → 06-04 08:00
        { start: "2025-06-03T20:00:00+08:00", end: "2025-06-04T08:00:00+08:00", modality: "standby" },
        // 远程办理手续 4 小时
        { start: "2025-06-05T14:00:00+08:00", end: "2025-06-05T18:00:00+08:00", modality: "remote_procedure" },
        // 与年假全天重叠
        { start: "2025-06-06T09:00:00+08:00", end: "2025-06-06T17:00:00+08:00", modality: "standby" },
        // 与第一段重复申报
        { start: "2025-06-04T04:00:00+08:00", end: "2025-06-04T06:00:00+08:00", modality: "standby" },
        // 证明覆盖之外
        { start: "2025-06-20T09:00:00+08:00", end: "2025-06-20T12:00:00+08:00", modality: "standby" },
      ],
      annual_leave: [{ start: "2025-06-06T00:00:00+08:00", end: "2025-06-07T00:00:00+08:00" }],
      shifts: [
        { shift_id: "SH-1", start: "2025-06-04T00:00:00+08:00", end: "2025-06-04T08:00:00+08:00" },
        { shift_id: "SH-2", start: "2025-06-06T09:00:00+08:00", end: "2025-06-06T17:00:00+08:00" },
      ],
      filed_at: "2025-06-16T09:00:00+08:00",
    },
    NOW,
  );

  const claimB = fileClaim(
    store,
    {
      case_id: CASE_ID,
      employee_id: "EMP-1002",
      proof_ids: [proofB.proof_id],
      care_periods: [
        // 与 claimA 的 06-04 00:00-08:00 轮换重叠 06:00-08:00
        { start: "2025-06-04T06:00:00+08:00", end: "2025-06-04T10:00:00+08:00", modality: "standby" },
      ],
      shifts: [
        { shift_id: "SH-9", start: "2025-06-04T06:00:00+08:00", end: "2025-06-04T14:00:00+08:00" },
      ],
      filed_at: "2025-06-17T09:00:00+08:00",
    },
    NOW,
  );

  return { store, proofA, proofB, claimA, claimB };
}
