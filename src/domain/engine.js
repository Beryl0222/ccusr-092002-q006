// 请假核算引擎（纯函数、确定性）：
// 把员工声明的照护时段、班次、年假、已核准记录与已验签凭证叠加，
// 按本地日（跨午夜）切分后依据当期制度分类，并记录每一段被排除的原因。
import {
  asInterval,
  intersect,
  localDayOf,
  minutesBetween,
  parseInstant,
  roundMoney,
  splitByLocalDay,
  subtract,
  toIso,
  unionMerge,
} from "./time.js";

const ICU_EVENT_KINDS = new Set(["admission", "critical_notice", "urgent_consent", "standby_request"]);
const FAMILY_EVENT_KINDS = new Set(["discharge", "transfer", "document_handling"]);

function certSupportsKind(cert, kind, mode) {
  const events = cert.facts.events ?? [];
  if (kind === "icu_care_leave") {
    if (mode === "remote") return false; // 重症照护假须现场
    if (cert.facts.icu_window) return true;
    return events.some((event) => ICU_EVENT_KINDS.has(event.kind));
  }
  if (kind === "family_care_leave") {
    return events.some((event) => FAMILY_EVENT_KINDS.has(event.kind));
  }
  if (kind === "remote_work") {
    return (
      mode === "remote" &&
      events.some(
        (event) =>
          FAMILY_EVENT_KINDS.has(event.kind) &&
          (event.presence === "remote" || event.presence === "unknown"),
      )
    );
  }
  return false;
}

// 找出某时刻落在其照护/ICU 窗口内的凭证。
function supportingCertificates(certs, instantIso) {
  const t = parseInstant(instantIso);
  return certs.filter((cert) => {
    const windows = [cert.facts.care_window];
    if (cert.facts.icu_window) windows.push(cert.facts.icu_window);
    return windows.some((window) => t >= parseInstant(window.start) && t < parseInstant(window.end));
  });
}

// 针对单个日内片段尝试指定假别；personal_affairs 永远可兜底。
function tryKindForPiece(kind, dayPiece, mode, certs, book, noon) {
  const supports = supportingCertificates(certs, dayPiece.start);
  if (kind === "personal_affairs") {
    return { kind, rule: book.ruleAt(kind, noon), certs: supports };
  }
  if (!supports.some((cert) => certSupportsKind(cert, kind, mode))) return null;
  const rule = book.ruleAt(kind, noon);
  if (rule.remote_required && mode !== "remote") return null;
  if (kind === "icu_care_leave" && mode === "remote" && rule.remote_eligible === false) return null;
  return { kind, rule, certs: supports };
}

function eventRefsFor(chosen) {
  const allowed =
    chosen.kind === "icu_care_leave"
      ? ICU_EVENT_KINDS
      : chosen.kind === "family_care_leave" || chosen.kind === "remote_work"
        ? FAMILY_EVENT_KINDS
        : null;
  return [
    ...new Set(
      chosen.certs.flatMap((cert) =>
        (cert.facts.events ?? [])
          .filter((event) => allowed === null || allowed.has(event.kind))
          .map((event) => event.ref),
      ),
    ),
  ];
}

// 输入：
// {
//   employee_id, hourly_rate,
//   shifts: [{id, start, end}],
//   declarations: { care: [{start,end,mode}], standby: [{start,end}] },
//   annual_leave: [{start,end}],                  // 已批准的年假
//   approved_intervals: [{start,end,claim_id}],  // 既往已核准区间（含跨员工轮换，查重）
//   relay_conflicts: [{start,end,with_employee}],// 与其他员工申报重叠的待裁定区间
//   certificates: [已验签凭证 payload],
//   now
// }
export function evaluateLeave(input, book) {
  for (const shift of input.shifts ?? []) asInterval(shift);
  const careWindows = unionMerge((input.declarations?.care ?? []).map(asInterval));
  const standbyWindows = unionMerge((input.declarations?.standby ?? []).map(asInterval));
  const annualWindows = unionMerge((input.annual_leave ?? []).map(asInterval));
  const approvedWindows = (input.approved_intervals ?? []).map((item) => ({
    ...asInterval(item),
    claim_id: item.claim_id,
  }));
  const relayConflicts = (input.relay_conflicts ?? []).map((item) => ({
    ...asInterval(item),
    with_employee: item.with_employee,
  }));
  const careDeclarations = input.declarations?.care ?? [];
  const certs = input.certificates ?? [];

  const exclusions = [];
  const segments = [];
  const quotas = new Map(); // policyId|kind -> {max_calendar_days, days:Set}

  const quotaRemaining = (rule, policyId, kind, day) => {
    if (!rule.max_calendar_days) return true;
    const record = quotas.get(`${policyId}|${kind}`);
    const used = record?.days;
    if (used && used.has(day)) return true; // 当天已占用，同日剩余片段仍归该假别
    return (used?.size ?? 0) < rule.max_calendar_days;
  };

  const noteDay = (rule, policyId, kind, day) => {
    if (!rule.max_calendar_days) return;
    const key = `${policyId}|${kind}`;
    if (!quotas.has(key)) quotas.set(key, { max_calendar_days: rule.max_calendar_days, days: new Set() });
    quotas.get(key).days.add(day);
  };

  const pushSegment = (rawPiece, shiftId, mode) => {
    for (const dayPiece of splitByLocalDay(rawPiece, book.offsetMinutes)) {
      const day = dayPiece.day;
      const noon = `${day}T12:00:00+08:00`;
      const policyId = book.versionAt(noon).id;

      // 现场：重症照护假 → 家庭照护假；远程：远程办公 → 家庭照护假；最后事假兜底。
      const chain =
        mode === "remote"
          ? ["remote_work", "family_care_leave", "personal_affairs"]
          : ["icu_care_leave", "family_care_leave", "personal_affairs"];

      let chosen = null;
      let fallbackReason = null;
      for (const candidateKind of chain) {
        const candidate = tryKindForPiece(candidateKind, dayPiece, mode, certs, book, noon);
        if (candidate && quotaRemaining(candidate.rule, policyId, candidateKind, day)) {
          chosen = candidate;
          if (candidateKind !== chain[0]) fallbackReason = `classified_as_${candidateKind}`;
          break;
        }
      }
      noteDay(chosen.rule, policyId, chosen.kind, day);

      // 日小时上限：超出部分计入排除。
      const totalMinutes = minutesBetween(dayPiece.start, dayPiece.end);
      const capMinutes = chosen.rule.daily_hours_cap ? chosen.rule.daily_hours_cap * 60 : totalMinutes;
      const billableMinutes = Math.min(totalMinutes, capMinutes);
      if (totalMinutes > capMinutes) {
        exclusions.push({
          start: toIso(parseInstant(dayPiece.start) + capMinutes),
          end: dayPiece.end,
          reason: "daily_hours_cap",
          detail: `${chosen.kind} 当日超出 ${chosen.rule.daily_hours_cap} 小时上限`,
          shift_id: shiftId,
          day,
        });
      }

      // 与其他亲属申报重叠：仍计算但挂起，不计入应付，待争议处理人裁定。
      const relayHit = relayConflicts
        .map((item) => intersect(dayPiece, item))
        .find(Boolean);

      segments.push({
        shift_id: shiftId,
        day,
        start: dayPiece.start,
        end: dayPiece.end,
        minutes: totalMinutes,
        billable_minutes: billableMinutes,
        mode,
        leave_kind: chosen.kind,
        policy_id: policyId,
        pay_rate: chosen.rule.pay_rate,
        certificate_ids: [...new Set(chosen.certs.map((cert) => cert.certificate_id))],
        event_refs: eventRefsFor(chosen),
        unsubstantiated: chosen.certs.length === 0,
        relay_pending: Boolean(relayHit),
        ...(relayHit
          ? { relay_with: relayConflicts.find((item) => intersect(dayPiece, item))?.with_employee }
          : {}),
        ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
      });
    }
  };

  // 对每个班次内的照护时段：先扣既往已核准（重复上传/申报不增加假期），
  // 再扣年假重叠（重叠段按年假，不进照护假），剩余片段按模式分类。
  for (const shift of input.shifts ?? []) {
    const absence = unionMerge(
      careWindows.map((window) => intersect(window, shift)).filter(Boolean),
    );
    for (const piece of absence) {
      let rest = [piece];
      for (const approved of approvedWindows) {
        const next = [];
        for (const item of rest) {
          const overlap = intersect(item, approved);
          if (!overlap) {
            next.push(item);
            continue;
          }
          exclusions.push({
            ...overlap,
            reason: "duplicate_claim",
            detail: `与已核准申请 ${approved.claim_id} 重叠，重复申报不增加假期`,
            shift_id: shift.id,
            day: localDayOf(parseInstant(overlap.start), book.offsetMinutes),
          });
          next.push(...subtract(item, [approved]));
        }
        rest = next;
      }
      for (const item of rest) {
        for (const annual of annualWindows) {
          const overlap = intersect(item, annual);
          if (overlap) {
            exclusions.push({
              ...overlap,
              reason: "annual_leave_overlap",
              detail: "与已排定年假重叠，按年假处理",
              shift_id: shift.id,
              day: localDayOf(parseInstant(overlap.start), book.offsetMinutes),
              leave_kind: "annual_leave",
            });
          }
        }
        for (const finalPiece of subtract(item, annualWindows)) {
          pushSegment(finalPiece, shift.id, pickMode(careDeclarations, finalPiece));
        }
      }
    }
  }

  // 非排班日的照护时段：不形成缺勤，仅留痕。
  const shiftUnion = unionMerge((input.shifts ?? []).map(asInterval));
  const nonScheduled = [];
  for (const window of careWindows) {
    for (const piece of subtract(window, shiftUnion)) {
      for (const dayPiece of splitByLocalDay(piece, book.offsetMinutes)) {
        nonScheduled.push({
          ...dayPiece,
          mode: pickMode(careDeclarations, dayPiece),
          within_certificate: supportingCertificates(certs, dayPiece.start).length > 0,
        });
      }
    }
  }

  // 待命时段（可跨午夜）：不计缺勤。院方待命请求在该待命窗口内发出，
  // 即覆盖其后全部片段（含跨午夜部分）。
  const standby = [];
  for (const window of standbyWindows) {
    const supporting = certs.filter((cert) =>
      (cert.facts.events ?? []).some(
        (event) =>
          event.kind === "standby_request" &&
          parseInstant(event.occurred_at) >= parseInstant(window.start) &&
          parseInstant(event.occurred_at) < parseInstant(window.end),
      ),
    );
    for (const piece of splitByLocalDay(window, book.offsetMinutes)) {
      standby.push({
        ...piece,
        substantiated: supporting.length > 0,
        certificate_ids: [...new Set(supporting.map((cert) => cert.certificate_id))],
      });
    }
  }

  // 同一患者多张凭证窗口重叠（多名亲属轮换）：提示而非拒绝。
  const overlapNotes = [];
  for (let i = 0; i < certs.length; i += 1) {
    for (let j = i + 1; j < certs.length; j += 1) {
      const hit = intersect(certs[i].facts.care_window, certs[j].facts.care_window);
      if (
        hit &&
        certs[i].patient_ref === certs[j].patient_ref &&
        certs[i].subject_pseudonym !== certs[j].subject_pseudonym
      ) {
        overlapNotes.push({
          interval: hit,
          reason: "multiple_relatives_window_overlap",
          detail: "多名亲属凭证窗口重叠，按各自主张的照护时段分别核算",
          subjects: [certs[i].subject_pseudonym, certs[j].subject_pseudonym],
        });
      }
    }
  }

  const rate = input.hourly_rate ?? 0;
  const totals = { by_kind: {}, payable_amount: 0, payable_minutes: 0, pending_minutes: 0 };
  for (const segment of segments) {
    const amount = segment.relay_pending
      ? 0
      : roundMoney((segment.billable_minutes / 60) * rate * segment.pay_rate);
    segment.pay_amount = amount;
    if (segment.relay_pending) totals.pending_minutes += segment.billable_minutes;
    const bucket = totals.by_kind[segment.leave_kind] ?? {
      minutes: 0,
      billable_minutes: 0,
      payable_minutes: 0,
      payable_amount: 0,
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

  const quota = [...quotas.entries()].map(([key, record]) => {
    const [policy_id, kind] = key.split("|");
    return {
      policy_id,
      kind,
      max_calendar_days: record.max_calendar_days,
      calendar_days_used: [...record.days].sort(),
    };
  });

  return {
    employee_id: input.employee_id,
    generated_at: input.now instanceof Date ? input.now.toISOString() : input.now,
    policy_versions: book.versionsCovering([...segments, ...standby]),
    segments: segments.sort(
      (a, b) => parseInstant(a.start) - parseInstant(b.start) || a.shift_id.localeCompare(b.shift_id),
    ),
    exclusions: exclusions.sort((a, b) => parseInstant(a.start) - parseInstant(b.start)),
    standby: standby.sort((a, b) => parseInstant(a.start) - parseInstant(b.start)),
    non_scheduled: nonScheduled.sort((a, b) => parseInstant(a.start) - parseInstant(b.start)),
    quota,
    overlap_notes: overlapNotes,
    totals,
  };
}

function pickMode(careDeclarations, piece) {
  const t = parseInstant(piece.start);
  const hit = careDeclarations.find((item) => {
    const declared = asInterval(item);
    return t >= parseInstant(declared.start) && t < parseInstant(declared.end);
  });
  return hit?.mode ?? "on_site";
}

// 主管视角：每班次缺勤分类与待命安排，只反映排班影响。
export function rosterImpact(evaluation, shifts = []) {
  const byShift = new Map();
  for (const segment of evaluation.segments) {
    const entry = byShift.get(segment.shift_id) ?? {
      shift_id: segment.shift_id,
      absent_minutes: 0,
      pending_minutes: 0,
      leave_kinds: new Set(),
      days: new Set(),
    };
    entry.absent_minutes += segment.minutes;
    if (segment.relay_pending) entry.pending_minutes += segment.minutes;
    entry.leave_kinds.add(segment.leave_kind);
    entry.days.add(segment.day);
    byShift.set(segment.shift_id, entry);
  }
  const shiftRows = [...byShift.values()].map((entry) => ({
    shift_id: entry.shift_id,
    absent_minutes: entry.absent_minutes,
    pending_minutes: entry.pending_minutes,
    leave_kinds: [...entry.leave_kinds].sort(),
    days: [...entry.days].sort(),
  }));

  // 待命与班次求交，输出班内待命分钟；班外待命按日汇总。
  const standbyRows = [];
  for (const item of evaluation.standby) {
    const hitShift = shifts.find((shift) => intersect(item, shift));
    standbyRows.push({
      day: item.day,
      start: item.start,
      end: item.end,
      shift_id: hitShift?.id ?? null,
      substantiated: item.substantiated,
    });
  }
  return { shifts: shiftRows, standby: standbyRows };
}
