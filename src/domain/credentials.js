// 最小化照护凭证：医院或合规见证方签发，内容不含诊断；
// 使用 Ed25519 分离签名，凭证可验证真伪与有效期，更正只产生新版本。
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";

import { parseInstant } from "./time.js";

export const CERTIFICATE_TYP = "care-certificate/1";
export const STATUS_TYP = "care-credential-status/1";
export const ALG = "EdDSA";

export const ISSUER_KINDS = new Set(["hospital", "witness"]);

// 凭证允许出现的事件类型：均为流程性事实，不含诊断内容。
export const EVENT_KINDS = new Set([
  "admission", // 入院
  "discharge", // 出院
  "transfer", // 转院
  "critical_notice", // 病危/病重通知
  "urgent_consent", // 紧急知情同意签署
  "standby_request", // 院方要求家属待命
  "document_handling", // 手续办理（可远程）
]);

// 见证方只能证明流程文书类事件，不能证明医疗区间。
const WITNESS_EVENT_KINDS = new Set(["document_handling", "transfer"]);

export function generateSigningKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    keyId: `key-${randomUUID()}`,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

// 稳定伪名：企业看到的是同一患者/亲属的稳定但不透明标识，
// 可用于跨员工查重，却无法还原身份或诊断。
export function pseudonym(issuerId, salt, kind, subjectCode) {
  const digest = createHash("sha256")
    .update(`${issuerId}|${salt}|${kind}|${subjectCode}`)
    .digest("hex")
    .slice(0, 24);
  return `${kind[0].toUpperCase()}-${digest}`;
}

export function canonicalJson(value) {
  const sort = (input) => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, sort(input[key])]),
      );
    }
    return input;
  };
  return JSON.stringify(sort(value));
}

function signPayload(privateKeyPem, payload) {
  // Ed25519/EdDSA 内部自带哈希，一次性签名接口的算法参数为 null。
  return cryptoSign(null, Buffer.from(canonicalJson(payload)), privateKeyPem).toString("base64");
}

function verifyEnvelope(envelope, publicKeyPem, expectedTyp) {
  if (!envelope || envelope.typ !== expectedTyp) {
    return { ok: false, reason: "envelope_type_mismatch" };
  }
  if (!envelope.sig || !envelope.payload) {
    return { ok: false, reason: "envelope_incomplete" };
  }
  const signatureOk = cryptoVerify(
    null,
    Buffer.from(canonicalJson(envelope.payload)),
    publicKeyPem,
    Buffer.from(envelope.sig, "base64"),
  );
  if (!signatureOk) return { ok: false, reason: "bad_signature" };
  return { ok: true, payload: envelope.payload };
}

function assertWindow(window, label) {
  if (!window) return;
  parseInstant(window.start);
  parseInstant(window.end);
  if (parseInstant(window.end) <= parseInstant(window.start)) {
    throw new Error(`${label} 区间必须为正长度`);
  }
}

function validateFacts(issuerKind, facts) {
  if (!facts || typeof facts !== "object") throw new Error("缺少凭证事实 facts");
  assertWindow(facts.care_window, "care_window");
  if (!facts.care_window) throw new Error("凭证至少须证明照护需求区间 care_window");
  if (facts.icu_window) {
    if (issuerKind !== "hospital") {
      throw new Error("见证方不得证明 ICU 区间");
    }
    assertWindow(facts.icu_window, "icu_window");
  }
  for (const event of facts.events ?? []) {
    if (!EVENT_KINDS.has(event.kind)) {
      throw new Error(`不支持的事件类型: ${event.kind}`);
    }
    if (issuerKind === "witness" && !WITNESS_EVENT_KINDS.has(event.kind)) {
      throw new Error(`见证方不得证明事件类型: ${event.kind}`);
    }
    parseInstant(event.occurred_at);
    if (event.presence && !["on_site", "remote"].includes(event.presence)) {
      throw new Error(`事件在场方式无效: ${event.presence}`);
    }
  }
}

// 签发方注册簿：持有私钥（演示用内存态），并登记每个凭证版本的状态。
export class IssuerRegistry {
  constructor(issuer) {
    if (!ISSUER_KINDS.has(issuer.kind)) throw new Error("签发方类型无效");
    if (!issuer.id || !issuer.name) throw new Error("签发方信息不完整");
    this.issuer = { ...issuer };
    this.records = new Map();
  }

  get directoryEntry() {
    return {
      id: this.issuer.id,
      name: this.issuer.name,
      kind: this.issuer.kind,
      keyId: this.issuer.keyId,
      publicKeyPem: this.issuer.publicKeyPem,
    };
  }

  issue({ subjectPseudonym, patientRef, relationship, facts, validDays = 30, now, certId }) {
    validateFacts(this.issuer.kind, facts);
    const issuedAt = now instanceof Date ? now.toISOString() : now;
    const id = certId ?? `CRT-${randomUUID().slice(0, 12).toUpperCase()}`;
    const payload = {
      certificate_id: id,
      schema: CERTIFICATE_TYP,
      issuer: { id: this.issuer.id, name: this.issuer.name, kind: this.issuer.kind },
      subject_pseudonym: subjectPseudonym,
      patient_ref: patientRef,
      relationship: relationship ?? "family_member",
      version: 1,
      supersedes: null,
      issued_at: issuedAt,
      valid_from: issuedAt,
      valid_until: new Date(parseInstant(issuedAt) + validDays * 86_400_000).toISOString(),
      facts: {
        care_window: facts.care_window,
        icu_window: facts.icu_window ?? null,
        events: (facts.events ?? []).map((event) => ({
          ref: event.ref ?? `EVT-${randomUUID().slice(0, 8)}`,
          kind: event.kind,
          occurred_at: event.occurred_at,
          presence: event.presence ?? "unknown",
        })),
      },
    };
    const envelope = {
      typ: CERTIFICATE_TYP,
      iss: this.issuer.id,
      kid: this.issuer.keyId,
      payload,
      sig: signPayload(this.issuer.privateKeyPem, payload),
    };
    this.records.set(id, {
      envelope,
      status: "active",
      supersededBy: null,
      revokeReason: null,
      history: [{ status: "active", at: issuedAt }],
    });
    return envelope;
  }

  // 医院更正：原凭证标记 superseded，签发新版本；历史凭证永不删除。
  supersede(oldId, { facts, now, reason }) {
    const old = this.records.get(oldId);
    if (!old) throw new Error(`原凭证不存在: ${oldId}`);
    const at = now instanceof Date ? now.toISOString() : now;
    old.status = "superseded";
    old.supersededBy = "pending";
    const payload = {
      ...old.envelope.payload,
      certificate_id: `CRT-${randomUUID().slice(0, 12).toUpperCase()}`,
      version: old.envelope.payload.version + 1,
      supersedes: oldId,
      issued_at: at,
      valid_from: at,
      correction_reason: reason ?? "院方信息更正",
      facts: undefined,
    };
    validateFacts(this.issuer.kind, facts);
    payload.facts = {
      care_window: facts.care_window,
      icu_window: facts.icu_window ?? null,
      events: (facts.events ?? []).map((event) => ({
        ref: event.ref ?? `EVT-${randomUUID().slice(0, 8)}`,
        kind: event.kind,
        occurred_at: event.occurred_at,
        presence: event.presence ?? "unknown",
      })),
    };
    const envelope = {
      typ: CERTIFICATE_TYP,
      iss: this.issuer.id,
      kid: this.issuer.keyId,
      payload,
      sig: signPayload(this.issuer.privateKeyPem, payload),
    };
    old.supersededBy = payload.certificate_id;
    old.history.push({ status: "superseded", at, by: payload.certificate_id });
    this.records.set(payload.certificate_id, {
      envelope,
      status: "active",
      supersededBy: null,
      revokeReason: null,
      history: [{ status: "active", at }],
    });
    return envelope;
  }

  revoke(id, { now, reason }) {
    const record = this.records.get(id);
    if (!record) throw new Error(`凭证不存在: ${id}`);
    const at = now instanceof Date ? now.toISOString() : now;
    record.status = "revoked";
    record.revokeReason = reason ?? null;
    record.history.push({ status: "revoked", at, reason: reason ?? null });
  }

  statusToken(id, { now }) {
    const record = this.records.get(id);
    if (!record) throw new Error(`凭证不存在: ${id}`);
    const observedAt = now instanceof Date ? now.toISOString() : now;
    const payload = {
      certificate_id: id,
      iss: this.issuer.id,
      kid: this.issuer.keyId,
      status: record.status,
      superseded_by: record.supersededBy && record.supersededBy !== "pending" ? record.supersededBy : null,
      revoke_reason: record.revokeReason,
      observed_at: observedAt,
      exp: new Date(parseInstant(observedAt) + 15 * 60_000).toISOString(),
    };
    return {
      typ: STATUS_TYP,
      iss: this.issuer.id,
      kid: this.issuer.keyId,
      payload,
      sig: signPayload(this.issuer.privateKeyPem, payload),
    };
  }
}

// 企业侧验证：对照签发方名录核验签名，并结合状态令牌与时刻判断可用性。
export function verifyCertificate(envelope, directory, { statusToken = null, now } = {}) {
  const issuer = directory[envelope?.iss];
  if (!issuer) return { ok: false, reason: "unknown_issuer" };
  if (envelope.kid !== issuer.keyId) return { ok: false, reason: "key_id_mismatch" };
  const result = verifyEnvelope(envelope, issuer.publicKeyPem, CERTIFICATE_TYP);
  if (!result.ok) return result;
  const payload = result.payload;
  const at = now instanceof Date ? now.getTime() : parseInstant(now);
  if (at < parseInstant(payload.valid_from)) return { ok: false, reason: "not_yet_valid", payload };
  if (at >= parseInstant(payload.valid_until)) return { ok: false, reason: "expired", payload };
  let status = "active";
  if (statusToken) {
    const statusResult = verifyStatusToken(statusToken, directory);
    if (!statusResult.ok) return { ok: false, reason: `status_${statusResult.reason}` };
    if (statusResult.payload.certificate_id !== payload.certificate_id) {
      return { ok: false, reason: "status_id_mismatch" };
    }
    if (parseInstant(statusResult.payload.exp) < at) {
      return { ok: false, reason: "status_token_expired" };
    }
    status = statusResult.payload.status;
  }
  if (status !== "active") return { ok: false, reason: status, payload };
  return { ok: true, payload, status };
}

export function verifyStatusToken(envelope, directory) {
  const issuer = directory?.[envelope?.iss];
  if (!issuer) return { ok: false, reason: "unknown_issuer" };
  if (envelope.kid !== issuer.keyId) return { ok: false, reason: "key_id_mismatch" };
  return verifyEnvelope(envelope, issuer.publicKeyPem, STATUS_TYP);
}

// 凭证披露字段清单：员工提交前可逐项预览将暴露给企业的内容。
export function disclosureFields(payload) {
  return [
    { field: "certificate_id", value: payload.certificate_id },
    { field: "issuer.name", value: payload.issuer.name },
    { field: "issuer.kind", value: payload.issuer.kind },
    { field: "subject_pseudonym", value: payload.subject_pseudonym },
    { field: "patient_ref", value: payload.patient_ref },
    { field: "relationship", value: payload.relationship },
    { field: "valid_from", value: payload.valid_from },
    { field: "valid_until", value: payload.valid_until },
    { field: "facts.care_window", value: payload.facts.care_window },
    ...(payload.facts.icu_window
      ? [{ field: "facts.icu_window", value: payload.facts.icu_window }]
      : []),
    {
      field: "facts.events",
      value: (payload.facts.events ?? []).map((event) => ({
        kind: event.kind,
        occurred_at: event.occurred_at,
        presence: event.presence,
      })),
    },
  ];
}
