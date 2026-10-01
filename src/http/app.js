// HTTP 应用：Bearer 令牌映射到角色与身份，按最小可见性暴露接口。

const ROLES = new Set(["employee", "manager", "hr", "payroll", "arbitrator", "issuer"]);

export function createAppContext({ service, tokens }) {
  // tokens: { "token-string": { role, id } }
  return { service, tokens: new Map(Object.entries(tokens ?? {})) };
}

function authenticate(context, request) {
  const header = request.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return { error: httpError(401, "缺少 Bearer 令牌") };
  const principal = context.tokens.get(match[1]);
  if (!principal || !ROLES.has(principal.role)) {
    return { error: httpError(401, "令牌无效") };
  }
  return { principal };
}

function requireRole(principal, ...roles) {
  if (!roles.includes(principal.role)) {
    throw httpError(403, `角色 ${principal.role} 无权访问，需要 ${roles.join("/")}`);
  }
}

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, extra });
}

async function readJson(request) {
  if (!request.headers["content-length"]) return {};
  try {
    const raw = await readBody(request);
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw httpError(400, "请求体不是合法 JSON");
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

// 路由表：[method, pattern, roles, handler]，pattern 段以 : 开头为参数。
const ROUTES = [
  ["POST", /^\/employees\/([^/]+)\/certificates\/preview$/, ["employee"], "previewCertificate"],
  ["POST", /^\/employees\/([^/]+)\/certificates$/, ["employee"], "submitCertificate"],
  ["POST", /^\/employees\/([^/]+)\/claims$/, ["employee"], "createClaim"],
  ["GET", /^\/employees\/([^/]+)\/claims$/, ["employee"], "listClaims"],

  ["GET", /^\/claims\/([^/]+)$/, ["employee", "hr", "arbitrator"], "getClaim"],
  ["POST", /^\/claims\/([^/]+)\/submit$/, ["employee"], "submitClaim"],
  ["POST", /^\/claims\/([^/]+)\/review$/, ["hr"], "reviewClaim"],
  ["POST", /^\/claims\/([^/]+)\/corrections$/, ["employee"], "correctCertificate"],
  ["POST", /^\/claims\/([^/]+)\/arbitration$/, ["arbitrator"], "recordArbitration"],
  ["POST", /^\/claims\/([^/]+)\/evidence-grants$/, ["hr"], "grantEvidence"],
  ["GET", /^\/claims\/([^/]+)\/evidence$/, ["arbitrator"], "evidenceChain"],

  ["GET", /^\/managers\/([^/]+)\/roster$/, ["manager"], "managerRoster"],
  ["GET", /^\/payroll$/, ["payroll"], "payroll"],
  ["GET", /^\/hr\/queue$/, ["hr"], "hrQueue"],
  ["GET", /^\/adjustments\/([^/]+)\/trace$/, ["payroll", "hr", "arbitrator"], "traceAdjustment"],

  // 签发方（演示用）：签发/更正/吊销凭证。
  ["POST", /^\/issuers\/([^/]+)\/certificates$/, ["issuer"], "issueCertificate"],
  ["POST", /^\/issuers\/([^/]+)\/certificates\/([^/]+)\/supersede$/, ["issuer"], "issuerSupersede"],
];

const HANDLERS = {
  async previewCertificate(context, principal, body, [employeeId]) {
    ensureSelf(principal, employeeId);
    return context.service.previewCertificate(body.certificate_envelope, body.status_token ?? null);
  },
  async submitCertificate(context, principal, body, [employeeId]) {
    ensureSelf(principal, employeeId);
    return context.service.submitCertificate(employeeId, body.certificate_envelope, {
      statusToken: body.status_token ?? null,
    });
  },
  async createClaim(context, principal, body, [employeeId]) {
    ensureSelf(principal, employeeId);
    return context.service.createClaim(employeeId, body);
  },
  async listClaims(context, principal, body, [employeeId]) {
    ensureSelf(principal, employeeId);
    return { claims: context.service.listClaims(employeeId) };
  },
  async getClaim(context, principal, body, [claimId]) {
    const claim = context.service.requireClaim(claimId);
    if (principal.role === "employee") ensureSelf(principal, claim.employee_id);
    if (principal.role === "arbitrator") {
      // 争议处理人须先获授权；授权后也只见状态与核算，不回传凭证信封。
      if (!context.service.validEvidenceGrant(claimId, principal.id)) {
        throw httpError(403, "未经授权查看该申请");
      }
      const view = context.service.employeeClaimView(claim);
      return {
        id: view.id,
        employee_id: view.employee_id,
        status: view.status,
        current_version: view.current_version,
        evaluation: { totals: view.evaluation.totals },
        decision: view.decision,
      };
    }
    return context.service.employeeClaimView(claim);
  },
  async submitClaim(context, principal, body, [claimId]) {
    const claim = context.service.requireClaim(claimId);
    ensureSelf(principal, claim.employee_id);
    return context.service.submitClaim(claimId);
  },
  async reviewClaim(context, principal, body, [claimId]) {
    return context.service.reviewClaim(claimId, {
      action: body.action,
      reason: body.reason,
      reviewer: principal.id,
    });
  },
  async correctCertificate(context, principal, body, [claimId]) {
    const claim = context.service.requireClaim(claimId);
    ensureSelf(principal, claim.employee_id);
    return context.service.applyCertificateCorrection(claimId, principal.id, body.certificate_envelope, {
      statusToken: body.status_token ?? null,
      reason: body.reason,
    });
  },
  async recordArbitration(context, principal, body, [claimId]) {
    return context.service.recordArbitration(claimId, {
      case_no: body.case_no,
      outcome: body.outcome,
      reason: body.reason,
      granted_intervals: body.granted_intervals ?? [],
      reviewer: principal.id,
    });
  },
  async grantEvidence(context, principal, body, [claimId]) {
    return context.service.grantEvidenceAccess(claimId, {
      grantee: body.grantee ?? principal.id,
      granted_by: principal.id,
      scope: body.scope ?? "evidence",
      expires_at: body.expires_at,
    });
  },
  async evidenceChain(context, principal, body, [claimId]) {
    return context.service.evidenceChain(claimId, { viewer: principal.id });
  },
  async managerRoster(context, principal, body, [managerId]) {
    ensureSelf(principal, managerId);
    return context.service.managerView(managerId);
  },
  async payroll(context) {
    return context.service.payrollView();
  },
  async hrQueue(context) {
    return { queue: context.service.hrQueue() };
  },
  async traceAdjustment(context, principal, body, [adjustmentId]) {
    return context.service.traceAdjustment(adjustmentId);
  },
  async issueCertificate(context, principal, body, [issuerId]) {
    if (principal.id !== issuerId) throw httpError(403, "令牌与签发方不一致");
    const registry = context.service.requireIssuer(issuerId);
    const envelope = registry.issue({
      subjectPseudonym: body.subject_pseudonym,
      patientRef: body.patient_ref,
      relationship: body.relationship,
      facts: body.facts,
      validDays: body.valid_days ?? 30,
      now: context.service.now(),
    });
    return { certificate_envelope: envelope };
  },
  async issuerSupersede(context, principal, body, [issuerId, certId]) {
    if (principal.id !== issuerId) throw httpError(403, "令牌与签发方不一致");
    const envelope = context.service.issuerSupersede(issuerId, certId, body.facts, body.reason);
    return { certificate_envelope: envelope };
  },
};

function ensureSelf(principal, employeeId) {
  if (principal.role === "employee" && principal.id !== employeeId) {
    throw httpError(403, "只能访问本人数据");
  }
}

export function createRequestHandler(context, { healthPayload }) {
  return async function handler(request, response) {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        return send(response, 200, healthPayload());
      }

      const auth = authenticate(context, request);
      if (auth.error) throw auth.error;

      const route = ROUTES.find(
        ([method, pattern]) => request.method === method && pattern.test(url.pathname),
      );
      if (!route) throw httpError(404, "未找到资源");
      const [method, pattern, roles, handlerName] = route;
      void method;
      requireRole(auth.principal, ...roles);
      const params = url.pathname.match(pattern).slice(1);
      const body = ["GET"].includes(request.method) ? {} : await readJson(request);
      const result = await HANDLERS[handlerName](context, auth.principal, body, params);
      return send(response, 200, result);
    } catch (error) {
      if (error.code === "access_denied") error.status = 403;
      if (error.code === "not_found") error.status = 404;
      if (error.code === "conflict") error.status = 409;
      if (error.code === "invalid_request") error.status = 400;
      const DOMAIN_CODES = new Set([
        "bad_signature", "unknown_issuer", "expired", "revoked", "superseded",
        "not_yet_valid", "key_id_mismatch", "status_token_expired",
      ]);
      if (DOMAIN_CODES.has(error.code)) error.status = 422;
      const status = error.status ?? 500;
      const payload = { error: error.message || "服务器错误" };
      if (error.extra && Object.keys(error.extra).length) Object.assign(payload, error.extra);
      return send(response, status, payload);
    }
  };
}

export { httpError };
