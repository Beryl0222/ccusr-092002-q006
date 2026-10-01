// 演示引导：构建内存态的签发方、员工与令牌。无真实个人资料。
import { generateSigningKeyPair, IssuerRegistry, pseudonym } from "./domain/credentials.js";
import { buildPolicyBook, defaultPolicyVersions } from "./domain/policy.js";
import { CareLeaveService } from "./domain/service.js";
import { createAppContext } from "./http/app.js";

export function bootstrapDemo({ clock } = {}) {
  // 默认固定在演示数据所在的 2025-06-10，使凭证有效期与授权窗口可复现；
  // 真实部署应注入实际时钟。
  let tick = 0;
  const baseMs = Date.parse("2025-06-10T10:00:00+08:00");
  const defaultClock = () => new Date(baseMs + tick++ * 1000).toISOString();
  const service = new CareLeaveService({ book: buildPolicyBook(defaultPolicyVersions()), clock: clock ?? defaultClock });

  const hospitalKeys = generateSigningKeyPair();
  const hospital = new IssuerRegistry({
    id: "HOSP-CENTRAL",
    name: "市中心医院",
    kind: "hospital",
    ...hospitalKeys,
  });
  service.registerIssuer(hospital);

  const witnessKeys = generateSigningKeyPair();
  const witness = new IssuerRegistry({
    id: "WIT-LEGAL",
    name: "合规见证服务中心",
    kind: "witness",
    ...witnessKeys,
  });
  service.registerIssuer(witness);

  service.addEmployee({
    id: "E001",
    name: "林某（演示员工）",
    manager_id: "M01",
    hourly_rate: 50,
    shifts: [
      { id: "S-0602", start: "2025-06-02T08:00:00+08:00", end: "2025-06-03T02:00:00+08:00" },
      { id: "S-0603", start: "2025-06-03T20:00:00+08:00", end: "2025-06-04T08:00:00+08:00" },
      { id: "S-0604", start: "2025-06-04T08:00:00+08:00", end: "2025-06-04T20:00:00+08:00" },
    ],
  });
  service.addEmployee({
    id: "E002",
    name: "周某（演示员工，轮换亲属）",
    manager_id: "M01",
    hourly_rate: 40,
    shifts: [
      { id: "T-0602", start: "2025-06-02T08:00:00+08:00", end: "2025-06-02T20:00:00+08:00" },
    ],
  });

  const tokens = {
    "tok-employee-e001": { role: "employee", id: "E001" },
    "tok-employee-e002": { role: "employee", id: "E002" },
    "tok-manager-m01": { role: "manager", id: "M01" },
    "tok-hr": { role: "hr", id: "hr-zhang" },
    "tok-payroll": { role: "payroll", id: "payroll-chen" },
    "tok-arbitrator": { role: "arbitrator", id: "arbiter-wang" },
    "tok-hospital": { role: "issuer", id: "HOSP-CENTRAL" },
    "tok-witness": { role: "issuer", id: "WIT-LEGAL" },
  };

  const context = createAppContext({ service, tokens });
  return {
    service,
    context,
    tokens,
    issuers: { hospital, witness },
    pseudonym: (employeeId, relCode) =>
      pseudonym(hospital.issuer.id, "demo-salt", "FAM", `${employeeId}|${relCode}`),
  };
}
