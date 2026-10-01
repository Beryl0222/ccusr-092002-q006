// 共享测试夹具：确定性时钟、签发方、员工、凭证。
import { generateSigningKeyPair, IssuerRegistry, pseudonym } from "../src/domain/credentials.js";
import { buildPolicyBook, defaultPolicyVersions } from "../src/domain/policy.js";
import { CareLeaveService } from "../src/domain/service.js";

export const NOW = "2025-06-10T10:00:00+08:00";

export function deterministicClock(start = NOW) {
  let tick = 0;
  return () => new Date(Date.parse(start) + tick++ * 1000).toISOString();
}

export function newService() {
  const book = buildPolicyBook(defaultPolicyVersions());
  return new CareLeaveService({ book, clock: deterministicClock() });
}

export function registerHospital(service, id = "HOSP-CENTRAL", name = "市中心医院") {
  const keys = generateSigningKeyPair();
  const registry = new IssuerRegistry({ id, name, kind: "hospital", ...keys });
  service.registerIssuer(registry);
  return registry;
}

export function registerWitness(service, id = "WIT-LEGAL", name = "合规见证服务中心") {
  const keys = generateSigningKeyPair();
  const registry = new IssuerRegistry({ id, name, kind: "witness", ...keys });
  service.registerIssuer(registry);
  return registry;
}

export function standardEmployee(service, id = "E001", managerId = "M01") {
  service.addEmployee({
    id,
    name: `员工${id}`,
    manager_id: managerId,
    hourly_rate: 50,
    shifts: [
      { id: "S-0602", start: "2025-06-02T08:00:00+08:00", end: "2025-06-03T02:00:00+08:00" },
      { id: "S-0603", start: "2025-06-03T20:00:00+08:00", end: "2025-06-04T08:00:00+08:00" },
      { id: "S-0604", start: "2025-06-04T08:00:00+08:00", end: "2025-06-04T20:00:00+08:00" },
    ],
  });
}

export function issueIcuCertificate(
  hospital,
  { subjectCode = "E001|REL-1", patientRef = "PAT-7788", relationship = "child", window, events, now } = {},
) {
  const care = window ?? {
    start: "2025-06-02T00:00:00+08:00",
    end: "2025-06-09T00:00:00+08:00",
  };
  return hospital.issue({
    subjectPseudonym: pseudonym(hospital.issuer.id, "test-salt", "FAM", subjectCode),
    patientRef,
    relationship,
    facts: {
      care_window: care,
      icu_window: care,
      events: events ?? [
        { ref: "EVT-A", kind: "admission", occurred_at: "2025-06-02T01:20:00+08:00" },
        { ref: "EVT-N", kind: "critical_notice", occurred_at: "2025-06-03T02:14:00+08:00" },
      ],
    },
    now: now ?? NOW,
  });
}

export function approveClaim(service, claimId, reviewer = "hr-li") {
  service.submitClaim(claimId);
  service.reviewClaim(claimId, { action: "approved", reviewer, reason: "测试核准" });
}
