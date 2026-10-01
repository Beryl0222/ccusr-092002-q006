// 最小化证明：由医院或合规见证方签发，只承载个案号、照护人、覆盖区间与
// 有效期，可验真伪与有效性，但不包含诊断等医疗细节。
import { canonicalize, hmacSha256hex, safeEqualHex, sha256hex } from "./canonical.js";
import { fail } from "./errors.js";
import { asDate, asInterval, isoInZone, parseMs } from "./intervals.js";

const ISSUER_KINDS = new Set(["hospital", "witness"]);

// 签发端守卫：证明载荷中不得出现诊断类信息（键或值都拦截）。
const FORBIDDEN_TERMS = [
  "diagnosis",
  "diagnoses",
  "icd",
  "disease",
  "pathology",
  "诊断",
  "病症",
  "病种",
  "病历",
];

export function registerIssuer(store, input = {}) {
  const { issuer_id: issuerId, kind, name, key } = input;
  if (!issuerId || !key) fail(400, "签发方登记需要 issuer_id 与 key");
  if (!ISSUER_KINDS.has(kind)) fail(400, "签发方类型须为 hospital 或 witness");
  const issuer = { issuer_id: issuerId, kind, name: name ?? issuerId, key };
  store.issuers.set(issuerId, issuer);
  const { key: _omit, ...publicIssuer } = issuer;
  return publicIssuer;
}

function assertMinimal(content) {
  const text = canonicalize(content).toLowerCase();
  for (const term of FORBIDDEN_TERMS) {
    if (text.includes(term.toLowerCase())) {
      fail(422, `证明不得包含诊断类信息（命中: ${term}）`);
    }
  }
}

function normalizeCoverage(entry) {
  if (!entry || !entry.kind) fail(400, "覆盖区间缺少 kind");
  const interval = asInterval(entry, "覆盖区间");
  return { kind: entry.kind, start: isoInZone(interval.start), end: isoInZone(interval.end) };
}

export function lineageRoot(store, proofId) {
  let current = store.proofs.get(proofId);
  if (!current) fail(404, `证明不存在: ${proofId}`);
  while (current.supersedes) current = store.proofs.get(current.supersedes);
  return current.proof_id;
}

export function latestInLineage(store, proofId) {
  const root = lineageRoot(store, proofId);
  const ids = store.lineages.get(root) ?? [root];
  return store.proofs.get(ids[ids.length - 1]);
}

function lineageHeads(store) {
  const heads = [];
  for (const ids of store.lineages.values()) {
    heads.push(store.proofs.get(ids[ids.length - 1]));
  }
  return heads;
}

export function issueProof(store, input = {}, now = new Date()) {
  const at = asDate(now);
  const issuer = store.issuers.get(input.issuer_id);
  if (!issuer) fail(404, `未知签发方: ${input.issuer_id ?? "缺失"}`);
  if (input.issuer_key !== issuer.key) fail(403, "签发方密钥不匹配");
  if (!input.case_id) fail(400, "证明缺少 case_id");
  if (!input.subject_employee_id) fail(400, "证明缺少 subject_employee_id");
  const coverage = (input.coverage ?? []).map((entry) => normalizeCoverage(entry));
  if (coverage.length === 0) fail(400, "证明须覆盖至少一个区间");
  const issuedAt = isoInZone(parseMs(input.issued_at ?? at.toISOString(), "issued_at"));
  const validUntil = isoInZone(parseMs(input.valid_until, "valid_until"));
  if (parseMs(validUntil) <= parseMs(issuedAt)) fail(400, "有效期必须晚于签发时间");

  const content = {
    proof_id: store.nextId("PRF"),
    case_id: input.case_id,
    version: input.version ?? 1,
    issuer_id: issuer.issuer_id,
    issuer_kind: issuer.kind,
    subject_employee_id: input.subject_employee_id,
    coverage,
    issued_at: issuedAt,
    valid_until: validUntil,
    supersedes: input.supersedes ?? null,
  };
  assertMinimal(content);

  // 重复上传幂等：同一签发方对同一照护人、同一覆盖内容与有效期，
  // 内容哈希相同即视为同一份证明，直接返回现有版本，不增加任何假期。
  const dedupHash = sha256hex(
    canonicalize({
      case_id: content.case_id,
      subject_employee_id: content.subject_employee_id,
      issuer_id: content.issuer_id,
      coverage: content.coverage,
      valid_until: content.valid_until,
    }),
  );
  for (const head of lineageHeads(store)) {
    if (head.dedup_hash === dedupHash && head.status !== "revoked") {
      return { proof: head, deduplicated: true };
    }
  }

  const signature = hmacSha256hex(canonicalize(content), issuer.key);
  const proof = { ...content, dedup_hash: dedupHash, signature, status: "active" };
  store.proofs.set(proof.proof_id, proof);
  const root = content.supersedes ? lineageRoot(store, content.supersedes) : proof.proof_id;
  if (!store.lineages.has(root)) store.lineages.set(root, []);
  store.lineages.get(root).push(proof.proof_id);
  return { proof, deduplicated: false };
}

// 医院更正：只产生新版本，旧版本标记为 superseded，历史决定不受影响。
export function correctProof(store, proofId, input = {}, now = new Date()) {
  const at = asDate(now);
  const old = store.proofs.get(proofId);
  if (!old) fail(404, `证明不存在: ${proofId}`);
  if (old.status === "revoked") fail(409, "已作废的证明不能更正");
  const head = latestInLineage(store, proofId);
  if (head.proof_id !== old.proof_id) fail(409, "只能更正该证明链的最新版本");
  const attempt = issueProof(
    store,
    {
      issuer_id: old.issuer_id,
      issuer_key: input.issuer_key,
      case_id: old.case_id,
      subject_employee_id: old.subject_employee_id,
      coverage: input.coverage ?? old.coverage,
      issued_at: input.issued_at ?? at.toISOString(),
      valid_until: input.valid_until ?? old.valid_until,
      version: old.version + 1,
      supersedes: old.proof_id,
    },
    at,
  );
  if (attempt.deduplicated) fail(409, "更正内容与原证明一致，无需新版本");
  old.status = "superseded";
  return { proof: attempt.proof, supersedes: old.proof_id };
}

// 真伪与有效期核验：签名、签发方、有效期窗口、版本状态逐项检查。
export function verifyProof(store, proofId, now = new Date()) {
  const at = asDate(now);
  const proof = store.proofs.get(proofId);
  if (!proof) fail(404, `证明不存在: ${proofId}`);
  const issuer = store.issuers.get(proof.issuer_id);
  const { signature, status, dedup_hash: _hash, ...content } = proof;
  const nowMs = at.getTime();
  const checks = {
    issuer_known: Boolean(issuer),
    signature_valid: issuer
      ? safeEqualHex(hmacSha256hex(canonicalize(content), issuer.key), signature)
      : false,
    within_validity: parseMs(proof.issued_at) <= nowMs && nowMs <= parseMs(proof.valid_until),
    status_active: status === "active",
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    proof_id: proof.proof_id,
    version: proof.version,
    status,
    latest_version_id: latestInLineage(store, proofId).proof_id,
  };
}
