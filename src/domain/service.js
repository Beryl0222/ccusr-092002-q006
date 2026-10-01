// 照护假核验服务（演示用内存态实现）：
// 负责凭证验签受理、申请预览/复核、医院更正与仲裁的版本化差额调整、
// 授权访问留痕，以及员工/主管/薪酬/争议四类角色视图。
import { randomUUID } from "node:crypto";

import {
  disclosureFields,
  IssuerRegistry,
  verifyCertificate,
} from "./credentials.js";
import { evaluateLeave, rosterImpact } from "./engine.js";
import {
  asInterval,
  intersect,
  parseInstant,
  roundMoney,
} from "./time.js";

export class CareLeaveService {
  constructor({ book, clock = () => new Date().toISOString() } = {}) {
    if (!book) throw new Error("缺少制度册 book");
    this.book = book;
    this.clock = clock;
    this.issuers = new Map(); // id -> IssuerRegistry（演示中同时模拟签发方状态端点）
    this.employees = new Map();
    this.certificates = new Map(); // certificate_id -> record（所有版本）
    this.claims = new Map();
    this.adjustments = new Map();
    this.grants = []; // 证据链授权
    this.accessLog = [];
    this.pseudonymOwners = new Map(); // subject_pseudonym -> employee_id
  }

  now() {
    return typeof this.clock === "function" ? this.clock() : this.clock;
  }

  // ---- 签发方（医院/合规见证方） ----------------------------------------
  registerIssuer(registry) {
    if (!(registry instanceof IssuerRegistry)) throw new Error("签发方注册簿类型无效");
    this.issuers.set(registry.issuer.id, registry);
    return registry.directoryEntry;
  }

  // 演示支持：由签发方注册簿直接更正凭证，返回新旧两版信封。
  issuerSupersede(issuerId, oldCertId, facts, reason) {
    const registry = this.requireIssuer(issuerId);
    const next = registry.supersede(oldCertId, { facts, now: this.now(), reason });
    this.linkCertificateVersion(oldCertId, next.payload.certificate_id);
    return next;
  }

  issuerRevoke(issuerId, certId, reason) {
    this.requireIssuer(issuerId).revoke(certId, { now: this.now(), reason });
  }

  requireIssuer(issuerId) {
    const registry = this.issuers.get(issuerId);
    if (!registry) throw Object.assign(new Error(`未知签发方: ${issuerId}`), { code: "not_found" });
    return registry;
  }

  get directory() {
    return Object.fromEntries(
      [...this.issuers.values()].map((registry) => [
        registry.issuer.id,
        registry.directoryEntry,
      ]),
    );
  }

  // 模拟向签发方状态端点拉取短期状态令牌。
  fetchStatusToken(certId) {
    for (const registry of this.issuers.values()) {
      if (registry.records.has(certId)) {
        return registry.statusToken(certId, { now: this.now() });
      }
    }
    throw new Error(`无法定位凭证签发方: ${certId}`);
  }

  // ---- 员工与排班 --------------------------------------------------------
  addEmployee({ id, name, manager_id, hourly_rate, shifts = [] }) {
    if (this.employees.has(id)) throw new Error(`员工已存在: ${id}`);
    for (const shift of shifts) asInterval(shift);
    this.employees.set(id, {
      id,
      name,
      manager_id: manager_id ?? null,
      hourly_rate: hourly_rate ?? 0,
      shifts: shifts.map((shift) => ({ ...asInterval(shift), id: shift.id })),
    });
  }

  // ---- 凭证受理 ----------------------------------------------------------
  // 仅预览将披露的字段与验签结果，不留存。
  previewCertificate(envelope, statusToken = null) {
    const result = verifyCertificate(envelope, this.directory, {
      statusToken,
      now: this.now(),
    });
    if (!result.ok) return { verified: false, reason: result.reason };
    return {
      verified: true,
      certificate_id: result.payload.certificate_id,
      version: result.payload.version,
      supersedes: result.payload.supersedes,
      valid_until: result.payload.valid_until,
      disclosure: disclosureFields(result.payload),
      note: "以上为提交后企业可见的全部字段；凭证不含诊断、检查或治疗细节。",
    };
  }

  submitCertificate(employeeId, envelope, { statusToken = null } = {}) {
    const employee = this.requireEmployee(employeeId);
    const result = verifyCertificate(envelope, this.directory, {
      statusToken: statusToken ?? this.optionalStatusToken(envelope.payload?.certificate_id),
      now: this.now(),
    });
    if (!result.ok) throw Object.assign(new Error(`凭证核验失败: ${result.reason}`), { code: result.reason });
    const payload = result.payload;

    // 同一稳定伪名出现在不同员工账户：可能是凭证误用，挂起待争议处理。
    const owner = this.pseudonymOwners.get(payload.subject_pseudonym);
    const pseudonymClash = owner && owner !== employeeId ? owner : null;
    if (!owner) this.pseudonymOwners.set(payload.subject_pseudonym, employeeId);

    if (payload.supersedes) this.linkCertificateVersion(payload.supersedes, payload.certificate_id);

    const record = {
      certificate_id: payload.certificate_id,
      version: payload.version,
      supersedes: payload.supersedes,
      issuer_id: payload.issuer.id,
      employee_id: employeeId,
      subject_pseudonym: payload.subject_pseudonym,
      patient_ref: payload.patient_ref,
      payload,
      received_at: this.now(),
      status_at_receipt: result.status,
      pseudonym_clash_with: pseudonymClash,
    };
    this.certificates.set(payload.certificate_id, record);
    return {
      certificate_id: record.certificate_id,
      version: record.version,
      supersedes: record.supersedes,
      status: record.status_at_receipt,
      pseudonym_clash: pseudonymClash
        ? { with_employee: pseudonymClash, handling: "需要争议处理人授权核查" }
        : null,
    };
  }

  optionalStatusToken(certId) {
    try {
      return this.fetchStatusToken(certId);
    } catch {
      return null;
    }
  }

  linkCertificateVersion(oldId, newId) {
    const old = this.certificates.get(oldId);
    if (old && !old.superseded_by) old.superseded_by = newId;
    const fresh = this.certificates.get(newId);
    if (fresh) fresh.supersedes = oldId;
  }

  activeCertificateChain(employeeId) {
    // 返回每位患者当前仍有效、未被取代的凭证版本。
    const byPatient = new Map();
    for (const record of this.certificates.values()) {
      if (record.employee_id !== employeeId) continue;
      const verify = verifyCertificate(
        this.latestEnvelope(record.certificate_id),
        this.directory,
        { statusToken: this.optionalStatusToken(record.certificate_id), now: this.now() },
      );
      if (!verify.ok) continue;
      const current = this.currentVersionId(record.certificate_id);
      if (current !== record.certificate_id) continue; // 只保留最新版
      byPatient.set(record.patient_ref, this.certificates.get(current));
    }
    return [...byPatient.values()];
  }

  currentVersionId(certId) {
    let current = certId;
    const seen = new Set([certId]);
    for (;;) {
      const record = this.certificates.get(current);
      if (!record?.superseded_by) return current;
      if (seen.has(record.superseded_by)) return current;
      seen.add(record.superseded_by);
      current = record.superseded_by;
    }
  }

  latestEnvelope(certId) {
    const current = this.currentVersionId(certId);
    const registry = [...this.issuers.values()].find((item) => item.records.has(current));
    return registry?.records.get(current)?.envelope;
  }

  // ---- 申请：预览 → 提交 → 复核 ------------------------------------------
  buildEvaluation(employeeId, input = {}, editingClaimId = null, options = {}) {
    const employee = this.requireEmployee(employeeId);
    const shifts = input.shifts ?? employee.shifts;
    const activeCerts = this.activeCertificateChain(employeeId);

    // 既往已核准区间：同员工跨申请查重；正在更正的申请自身不计入，
    // 否则其历史核准会把本次申报全部挤成重复。
    const approvedIntervals = [];
    for (const claim of this.claims.values()) {
      if (claim.employee_id !== employeeId || claim.id === editingClaimId) continue;
      const approvedVersion = this.latestApprovedVersion(claim);
      if (!approvedVersion) continue;
      for (const segment of approvedVersion.evaluation.segments) {
        approvedIntervals.push({
          start: segment.start,
          end: segment.end,
          claim_id: claim.id,
        });
      }
    }

    // 同一患者被多名员工申报（亲属轮换）：照护时段重叠的部分挂起待裁定，
    // 防止多名亲属对同一时段重复计假。比对范围含在途与已核准申请。
    const myPatientRefs = new Set(activeCerts.map((record) => record.patient_ref));
    const relayConflicts = [];
    for (const otherClaim of this.claims.values()) {
      if (otherClaim.employee_id === employeeId || otherClaim.id === editingClaimId) continue;
      if (["draft", "rejected"].includes(otherClaim.status)) continue;
      const otherLatest = otherClaim.versions[otherClaim.versions.length - 1];
      const otherPatientRefs = new Set(
        otherLatest.evaluation.segments
          .flatMap((segment) => segment.certificate_ids)
          .map((certId) => this.certificates.get(certId)?.patient_ref)
          .filter(Boolean),
      );
      for (const patientRef of myPatientRefs) {
        if (!otherPatientRefs.has(patientRef)) continue;
        for (const segment of otherLatest.evaluation.segments) {
          const refsSegment = segment.certificate_ids
            .map((certId) => this.certificates.get(certId)?.patient_ref)
            .includes(patientRef);
          if (!refsSegment) continue;
          relayConflicts.push({
            start: segment.start,
            end: segment.end,
            with_employee: otherClaim.employee_id,
            patient_ref: patientRef,
          });
        }
      }
    }

    return evaluateLeave(
      {
        employee_id: employeeId,
        hourly_rate: employee.hourly_rate,
        shifts,
        declarations: input.declarations ?? { care: [], standby: [] },
        annual_leave: input.annual_leave ?? [],
        approved_intervals: approvedIntervals,
        relay_conflicts: relayConflicts,
        certificates: activeCerts.map((record) => record.payload),
        now: this.now(),
      },
      this.book,
    );
  }

  createClaim(employeeId, input) {
    this.requireEmployee(employeeId);
    const id = `CLM-${randomUUID().slice(0, 10).toUpperCase()}`;
    const evaluation = this.buildEvaluation(employeeId, input);
    const claim = {
      id,
      employee_id: employeeId,
      status: "draft",
      created_at: this.now(),
      versions: [
        {
          version: 1,
          reason: "draft",
          created_at: this.now(),
          input: cloneInput(input),
          evaluation,
          certificate_snapshot: this.snapshotCertificates(evaluation),
          decision: null,
        },
      ],
    };
    this.claims.set(id, claim);
    return this.employeeClaimView(claim);
  }

  submitClaim(claimId) {
    const claim = this.requireClaim(claimId);
    if (claim.status !== "draft") throw Object.assign(new Error("仅草稿状态可提交"), { code: "conflict" });
    claim.status = "submitted";
    return this.employeeClaimView(claim);
  }

  reviewClaim(claimId, { action, reason, reviewer }) {
    const claim = this.requireClaim(claimId);
    if (!["submitted", "under_arbitration"].includes(claim.status)) {
      throw Object.assign(new Error("当前状态不可复核"), { code: "conflict" });
    }
    if (!["approved", "rejected"].includes(action)) {
      throw Object.assign(new Error("复核决定无效"), { code: "invalid_request" });
    }
    const version = claim.versions[claim.versions.length - 1];
    version.decision = {
      action,
      reason: reason ?? null,
      reviewer: reviewer ?? "hr",
      decided_at: this.now(),
    };
    // 更正差额随新版本复核结果过账或作废；驳回时维持上一核准版本。
    const pending = [...this.adjustments.values()].filter(
      (item) => item.claim_id === claim.id && item.to_version === version.version && item.status === "pending_review",
    );
    for (const adjustment of pending) {
      adjustment.status = action === "approved" ? "posted" : "voided";
      adjustment.reviewed_by = reviewer ?? "hr";
      adjustment.reviewed_at = this.now();
    }
    claim.status = action === "approved" ? "approved" : "rejected";
    return this.employeeClaimView(claim);
  }

  latestApprovedVersion(claim) {
    for (let i = claim.versions.length - 1; i >= 0; i -= 1) {
      if (claim.versions[i].decision?.action === "approved") return claim.versions[i];
    }
    return null;
  }

  // ---- 医院更正：重新核算，只产生新版本与差额调整 ------------------------
  applyCertificateCorrection(claimId, employeeId, newEnvelope, { statusToken = null, reason } = {}) {
    const claim = this.requireClaim(claimId);
    if (claim.employee_id !== employeeId) {
      throw Object.assign(new Error("无权操作此申请"), { code: "access_denied" });
    }
    this.submitCertificate(employeeId, newEnvelope, { statusToken });

    const previous = claim.versions[claim.versions.length - 1];
    const evaluation = this.buildEvaluation(employeeId, previous.input, claim.id);
    const versionNo = claim.versions.length + 1;
    claim.versions.push({
      version: versionNo,
      reason: `hospital_correction: ${reason ?? newEnvelope.payload.correction_reason ?? "院方更正"}`,
      created_at: this.now(),
      input: previous.input,
      evaluation,
      certificate_snapshot: this.snapshotCertificates(evaluation),
      decision: null,
    });

    const adjustment = this.postAdjustment(claim, previous, claim.versions[claim.versions.length - 1], {
      trigger: "hospital_correction",
      reason: reason ?? newEnvelope.payload.correction_reason ?? "院方更正凭证",
    });
    // 更正产生待复核新版本；历史核准区间已被差额调整取代。
    claim.status = "submitted";
    return { claim: this.employeeClaimView(claim), adjustment };
  }

  // ---- 劳动仲裁：裁决结果入账，同样只产生新版本与差额 --------------------
  recordArbitration(claimId, { case_no, outcome, reason, granted_intervals = [], reviewer }) {
    const claim = this.requireClaim(claimId);
    const previous = claim.versions[claim.versions.length - 1];
    claim.status = "under_arbitration";

    // 裁决授予区间：并入申报后重新核算；未获支持的区间不产生变化。
    const input = cloneInput(previous.input);
    input.declarations ??= { care: [], standby: [] };
    input.declarations.care ??= [];
    for (const interval of granted_intervals) {
      input.declarations.care.push({
        ...asInterval(interval),
        mode: interval.mode ?? "on_site",
        arbitration_leave_kind: interval.leave_kind ?? "icu_care_leave",
        arbitration_granted: true,
      });
    }
    input.arbitration = {
      case_no,
      outcome, // uphold | modify | deny
      reason: reason ?? null,
    };

    const evaluation = this.buildEvaluation(claim.employee_id, input, claim.id);
    // 裁决授予的片段：按裁决指定假别计付，解除凭证不足与轮换挂起。
    const grants = granted_intervals.map((interval) => ({
      window: asInterval(interval),
      leave_kind: interval.leave_kind ?? "icu_care_leave",
    }));
    for (const segment of evaluation.segments) {
      const hit = grants.find((grant) => intersect(segment, grant.window));
      if (!hit) continue;
      segment.unsubstantiated = false;
      segment.relay_pending = false;
      delete segment.relay_with;
      segment.arbitration_case = case_no;
      const rule = this.book.ruleAt(hit.leave_kind, `${segment.day}T12:00:00+08:00`);
      segment.leave_kind = hit.leave_kind;
      segment.pay_rate = rule.pay_rate;
      segment.policy_id = this.book.versionAt(`${segment.day}T12:00:00+08:00`).id;
      segment.fallback_reason = `arbitration_granted_as_${hit.leave_kind}`;
    }
    this.recomputeTotals(evaluation);

    claim.versions.push({
      version: claim.versions.length + 1,
      reason: `arbitration: ${case_no} (${outcome})`,
      created_at: this.now(),
      input,
      evaluation,
      certificate_snapshot: this.snapshotCertificates(evaluation),
      decision: {
        action: "approved",
        reason: `按劳动仲裁裁决 ${case_no} 入账：${reason ?? outcome}`,
        reviewer: reviewer ?? "arbitration_board",
        decided_at: this.now(),
      },
    });
    claim.status = "approved";
    const adjustment = this.postAdjustment(claim, previous, claim.versions[claim.versions.length - 1], {
      trigger: "arbitration",
      reason: `劳动仲裁 ${case_no}：${reason ?? outcome}`,
      case_no,
    });
    return { claim: this.employeeClaimView(claim), adjustment };
  }

  recomputeTotals(evaluation) {
    const rate = this.requireEmployee(evaluation.employee_id).hourly_rate;
    const totals = { by_kind: {}, payable_amount: 0, payable_minutes: 0, pending_minutes: 0 };
    for (const segment of evaluation.segments) {
      const amount = segment.relay_pending
        ? 0
        : roundMoney((segment.billable_minutes / 60) * rate * segment.pay_rate);
      segment.pay_amount = amount;
      if (segment.relay_pending) totals.pending_minutes += segment.billable_minutes;
      const bucket = totals.by_kind[segment.leave_kind] ?? {
        minutes: 0, billable_minutes: 0, payable_minutes: 0, payable_amount: 0,
      };
      bucket.minutes += segment.minutes;
      bucket.billable_minutes += segment.billable_minutes;
      if (!segment.relay_pending) {
        bucket.payable_minutes += segment.billable_minutes;
        bucket.payable_amount = roundMoney(bucket.payable_amount + amount);
        totals.payable_amount = roundMoney(totals.payable_amount + amount);
        totals.payable_minutes += segment.billable_minutes;
      }
      totals.by_kind[segment.leave_kind] = bucket;
    }
    evaluation.totals = totals;
  }

  postAdjustment(claim, previous, next, { trigger, reason, case_no = null }) {
    const id = `ADJ-${randomUUID().slice(0, 10).toUpperCase()}`;
    const oldAmount = approvedPayable(previous);
    const newAmount = approvedPayable(next);
    const adjustment = {
      id,
      claim_id: claim.id,
      employee_id: claim.employee_id,
      trigger, // hospital_correction | arbitration
      reason,
      case_no,
      created_at: this.now(),
      from_version: previous.version,
      to_version: next.version,
      old_payable_amount: oldAmount,
      new_payable_amount: newAmount,
      delta_amount: roundMoney(newAmount - oldAmount),
      // 医院更正须经复核才过账；仲裁裁决即时入账。
      status: trigger === "arbitration" ? "posted" : "pending_review",
    };
    this.adjustments.set(id, adjustment);
    return adjustment;
  }

  // 从一笔薪资调整复原完整决策链路：所用制度、凭证状态、排除重叠、最终决定。
  traceAdjustment(adjustmentId) {
    const adjustment = this.adjustments.get(adjustmentId);
    if (!adjustment) throw Object.assign(new Error(`调整不存在: ${adjustmentId}`), { code: "not_found" });
    const claim = this.requireClaim(adjustment.claim_id);
    const from = claim.versions.find((version) => version.version === adjustment.from_version);
    const to = claim.versions.find((version) => version.version === adjustment.to_version);
    return {
      adjustment,
      employee_id: claim.employee_id,
      policy_basis: to.evaluation.policy_versions,
      versions: [from, to].map((version) => ({
        version: version.version,
        reason: version.reason,
        created_at: version.created_at,
        decision: version.decision,
        certificates: version.certificate_snapshot,
        totals: version.evaluation.totals,
        quota: version.evaluation.quota,
        excluded_overlaps: version.evaluation.exclusions,
        pending_segments: version.evaluation.segments.filter((segment) => segment.relay_pending),
      })),
      final_review: to.decision ?? claim.versions[claim.versions.length - 1].decision,
    };
  }

  snapshotCertificates(evaluation) {
    const ids = new Set(evaluation.segments.flatMap((segment) => segment.certificate_ids));
    return [...ids].map((certId) => {
      const registry = [...this.issuers.values()].find((item) => item.records.has(certId));
      const issuerRecord = registry?.records.get(certId);
      const record = this.certificates.get(certId);
      return {
        certificate_id: certId,
        version: issuerRecord?.envelope.payload.version ?? null,
        issuer_id: record?.issuer_id ?? null,
        status: issuerRecord?.status ?? "unknown",
        superseded_by: issuerRecord?.supersededBy ?? null,
        valid_until: issuerRecord?.envelope.payload.valid_until ?? null,
        facts_summary: issuerRecord
          ? {
              care_window: issuerRecord.envelope.payload.facts.care_window,
              icu_window: issuerRecord.envelope.payload.facts.icu_window,
              event_kinds: issuerRecord.envelope.payload.facts.events.map((event) => event.kind),
            }
          : null,
      };
    });
  }

  // ---- 授权与证据链查看（争议处理人） ------------------------------------
  grantEvidenceAccess(claimId, { grantee, granted_by, scope = "evidence", expires_at }) {
    const claim = this.requireClaim(claimId);
    const grant = {
      id: `GRT-${randomUUID().slice(0, 8).toUpperCase()}`,
      claim_id: claimId,
      grantee,
      granted_by,
      scope,
      created_at: this.now(),
      expires_at: expires_at ?? null,
    };
    this.grants.push(grant);
    return grant;
  }

  validEvidenceGrant(claimId, viewer) {
    return this.grants.find(
      (item) =>
        item.claim_id === claimId &&
        item.grantee === viewer &&
        (!item.expires_at || parseInstant(item.expires_at) > parseInstant(this.now())),
    );
  }

  evidenceChain(claimId, { viewer }) {
    const claim = this.requireClaim(claimId);
    const grant = this.validEvidenceGrant(claimId, viewer);
    if (!grant) throw Object.assign(new Error("未经授权查看证据链"), { code: "access_denied" });
    this.accessLog.push({
      claim_id: claimId,
      viewer,
      grant_id: grant.id,
      viewed_at: this.now(),
    });
    return {
      claim_id: claimId,
      grant,
      certificates: claim.versions[claim.versions.length - 1].certificate_snapshot,
      raw_events: claim.versions.flatMap((version) =>
        version.evaluation.segments.flatMap((segment) =>
          segment.certificate_ids.map((certificate_id) => ({
            version: version.version,
            certificate_id,
            event_refs: segment.event_refs,
          })),
        ),
      ),
      versions: claim.versions.map((version) => ({
        version: version.version,
        reason: version.reason,
        created_at: version.created_at,
        decision: version.decision,
        input: version.input,
        evaluation: {
          segments: version.evaluation.segments,
          exclusions: version.evaluation.exclusions,
          standby: version.evaluation.standby,
          quota: version.evaluation.quota,
          policy_versions: version.evaluation.policy_versions,
          totals: version.evaluation.totals,
          overlap_notes: version.evaluation.overlap_notes,
        },
      })),
      adjustments: [...this.adjustments.values()].filter((item) => item.claim_id === claimId),
    };
  }

  // ---- 角色视图 ----------------------------------------------------------
  employeeClaimView(claim) {
    const latest = claim.versions[claim.versions.length - 1];
    return {
      id: claim.id,
      employee_id: claim.employee_id,
      status: claim.status,
      created_at: claim.created_at,
      current_version: latest.version,
      disclosure_preview: latest.certificate_snapshot,
      evaluation: {
        totals: latest.evaluation.totals,
        segments: latest.evaluation.segments,
        exclusions: latest.evaluation.exclusions,
        standby: latest.evaluation.standby,
        non_scheduled: latest.evaluation.non_scheduled,
        quota: latest.evaluation.quota,
        policy_versions: latest.evaluation.policy_versions,
        overlap_notes: latest.evaluation.overlap_notes,
      },
      decision: latest.decision,
      versions: claim.versions.map((version) => ({
        version: version.version,
        reason: version.reason,
        created_at: version.created_at,
        decision: version.decision,
      })),
    };
  }

  listClaims(employeeId) {
    return [...this.claims.values()]
      .filter((claim) => claim.employee_id === employeeId)
      .map((claim) => this.employeeClaimView(claim));
  }

  // 主管：只见排班影响（缺勤分钟、假别类别、待命），不见凭证与金额。
  managerView(managerId) {
    const rows = [];
    for (const employee of this.employees.values()) {
      if (employee.manager_id !== managerId) continue;
      const claims = [...this.claims.values()].filter(
        (claim) =>
          claim.employee_id === employee.id &&
          ["submitted", "approved", "adjusted", "under_arbitration"].includes(claim.status),
      );
      for (const claim of claims) {
        const latest = claim.versions[claim.versions.length - 1];
        rows.push({
          claim_id: claim.id,
          employee_id: employee.id,
          status: claim.status,
          roster_impact: rosterImpact(latest.evaluation, employee.shifts),
        });
      }
    }
    return { manager_id: managerId, claims: rows };
  }

  // 薪酬：只见已核准区间与已过账调整。每个申请只取最近核准版本，
  // 历史版本的差异以差额调整体现，避免新旧区间双重计薪。
  payrollView() {
    const entries = [];
    for (const claim of this.claims.values()) {
      const version = this.latestApprovedVersion(claim);
      if (!version) continue;
      for (const segment of version.evaluation.segments) {
        if (segment.relay_pending) continue;
        entries.push({
          claim_id: claim.id,
          employee_id: claim.employee_id,
          version: version.version,
          start: segment.start,
          end: segment.end,
          leave_kind: segment.leave_kind,
          payable_minutes: segment.billable_minutes,
          pay_amount: segment.pay_amount,
        });
      }
    }
    return {
      approved_intervals: entries,
      adjustments: [...this.adjustments.values()].filter((item) => item.status === "posted"),
    };
  }

  hrQueue() {
    return [...this.claims.values()]
      .filter((claim) => claim.status === "submitted" || claim.status === "under_arbitration")
      .map((claim) => {
        const latest = claim.versions[claim.versions.length - 1];
        return {
          claim_id: claim.id,
          employee_id: claim.employee_id,
          status: claim.status,
          submitted_at: claim.created_at,
          current_version: latest.version,
          totals: latest.evaluation.totals,
          unsubstantiated_minutes: latest.evaluation.segments.reduce(
            (sum, segment) => sum + (segment.unsubstantiated ? segment.minutes : 0),
            0,
          ),
          pending_relay_minutes: latest.evaluation.segments.reduce(
            (sum, segment) => sum + (segment.relay_pending ? segment.minutes : 0),
            0,
          ),
          certificates: latest.certificate_snapshot,
          exclusions: latest.evaluation.exclusions,
        };
      });
  }

  requireEmployee(employeeId) {
    const employee = this.employees.get(employeeId);
    if (!employee) throw Object.assign(new Error(`员工不存在: ${employeeId}`), { code: "not_found" });
    return employee;
  }

  requireClaim(claimId) {
    const claim = this.claims.get(claimId);
    if (!claim) throw Object.assign(new Error(`申请不存在: ${claimId}`), { code: "not_found" });
    return claim;
  }
}

function approvedPayable(version) {
  return roundMoney(version.evaluation.totals.payable_amount ?? 0);
}

function cloneInput(input) {
  return JSON.parse(JSON.stringify(input));
}
