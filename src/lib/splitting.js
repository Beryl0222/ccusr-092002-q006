// 拆分引擎：把员工申报的照护时段按当期制度拆成"核准区间"与"排除区间"。
// 管线顺序固定、纯函数式，保证同一输入永远得到同一结果，可事后复原。
import { fail } from "./errors.js";
import {
  asInterval,
  intersectMany,
  isoInZone,
  minutesBetween,
  parseMs,
  splitAtCalendarDays,
  subtract,
  toHours,
  unionMerge,
} from "./intervals.js";
import { latestInLineage } from "./proofs.js";

// 因"重叠"而被排除的时间（审计复原时的重点）。
export const OVERLAP_REASONS = [
  "annual_leave_overlap",
  "rotation_overlap",
  "duplicate_within_claim",
  "duplicate",
];

// 远程办理折算/封顶产生的是工时调整而非时间重叠。
export const HOUR_ADJUST_REASONS = ["remote_procedure_ratio", "remote_daily_cap"];

const MODALITIES = new Set(["standby", "on_site", "remote_procedure"]);

function coverageUnion(store, claim) {
  const blocks = [];
  for (const proofId of claim.proof_ids) {
    const proof = latestInLineage(store, proofId);
    if (!proof || proof.status !== "active") continue;
    for (const entry of proof.coverage) {
      blocks.push({ start: parseMs(entry.start), end: parseMs(entry.end) });
    }
  }
  return unionMerge(blocks, { mergeTouching: true });
}

// 单笔申请的前四步：证明覆盖裁剪 → 年假剔除 → 跨午夜拆段 → 自身去重。
function preparePieces(store, claim, tzOffset) {
  const excluded = [];
  const coverage = coverageUnion(store, claim);
  const annualLeave = (claim.annual_leave ?? []).map((entry) => asInterval(entry, "年假区间"));

  let pieces = (claim.care_periods ?? []).map((period) => ({
    ...asInterval(period, "照护时段"),
    modality: period.modality ?? "standby",
  }));
  for (const piece of pieces) {
    if (!MODALITIES.has(piece.modality)) fail(400, `未知照护方式: ${piece.modality}`);
  }

  // 1. 只保留证明覆盖的时间，覆盖之外的一律排除。
  const clipped = [];
  for (const piece of pieces) {
    for (const outside of subtract(piece, coverage)) {
      excluded.push({ ...outside, reason: "outside_proof_coverage" });
    }
    for (const hit of intersectMany(piece, coverage)) {
      clipped.push({ ...piece, start: hit.start, end: hit.end });
    }
  }

  // 2. 与年假重叠的部分剔除，不能重复计假。
  let afterAnnual = [];
  for (const piece of clipped) {
    for (const hit of intersectMany(piece, annualLeave)) {
      excluded.push({ ...piece, start: hit.start, end: hit.end, reason: "annual_leave_overlap" });
    }
    afterAnnual = afterAnnual.concat(subtract(piece, annualLeave));
  }

  // 3. 跨午夜待命按自然日拆段。
  const split = afterAnnual.flatMap((piece) => splitAtCalendarDays(piece, tzOffset));

  // 4. 同一申请内重复申报的时段只计一次。
  split.sort((a, b) => a.start - b.start || a.end - b.end);
  const accepted = [];
  for (const piece of split) {
    for (const hit of intersectMany(piece, accepted)) {
      excluded.push({ ...piece, start: hit.start, end: hit.end, reason: "duplicate_within_claim" });
    }
    accepted.push(...subtract(piece, accepted));
  }
  return { pieces: accepted, excluded };
}

function formatApproved(piece, tzOffset) {
  return {
    start: isoInZone(piece.start, tzOffset),
    end: isoInZone(piece.end, tzOffset),
    day: piece.day,
    modality: piece.modality,
    gross_minutes: piece.gross_minutes,
    counted_minutes: piece.counted_minutes,
    gross_hours: toHours(piece.gross_minutes),
    counted_hours: toHours(piece.counted_minutes),
    ...(piece.reinstated ? { reinstated: true } : {}),
  };
}

function formatExcluded(item, tzOffset) {
  const excludedMinutes = item.excluded_minutes ?? minutesBetween(item);
  const out = {
    start: isoInZone(item.start, tzOffset),
    end: isoInZone(item.end, tzOffset),
    reason: item.reason,
    excluded_minutes: excludedMinutes,
    excluded_hours: toHours(excludedMinutes),
  };
  if (item.day) out.day = item.day;
  if (item.allocated_to) out.allocated_to = item.allocated_to;
  if (item.gross_minutes != null) out.gross_minutes = item.gross_minutes;
  if (item.counted_minutes != null) out.counted_minutes = item.counted_minutes;
  return out;
}

// 主入口：对一笔请假申请按当期制度拆分。
// reinstateReasons 供仲裁使用：把指定原因的排除项恢复为核准。
export function splitClaimEntitlement(store, claim, { policy, reinstateReasons = [] } = {}) {
  const tzOffset = policy.rules.timezone_offset_minutes ?? 480;
  const self = preparePieces(store, claim, tzOffset);
  const excluded = [...self.excluded];
  let pieces = self.pieces;

  // 5. 亲属轮换：同一个案同一时段只计一名照护人，按申报先后分配——
  //    只有申报更早（平手时 claim_id 更小）的申请才占用时段；
  //    同一员工重复申报的时段记为 duplicate，不增加假期。
  const priorityOf = (other) =>
    parseMs(other.filed_at, "申报时间") - parseMs(claim.filed_at, "申报时间") ||
    other.claim_id.localeCompare(claim.claim_id);
  const siblings = [...store.claims.values()]
    .filter(
      (other) =>
        other.case_id === claim.case_id && other.claim_id !== claim.claim_id && priorityOf(other) < 0,
    )
    .sort(
      (a, b) =>
        parseMs(a.filed_at, "申报时间") - parseMs(b.filed_at, "申报时间") ||
        a.claim_id.localeCompare(b.claim_id),
    );
  for (const sibling of siblings) {
    const prepared = preparePieces(store, sibling, tzOffset);
    if (prepared.pieces.length === 0) continue;
    const siblingUnion = unionMerge(prepared.pieces, { mergeTouching: true });
    const reason = sibling.employee_id === claim.employee_id ? "duplicate" : "rotation_overlap";
    const remaining = [];
    for (const piece of pieces) {
      for (const hit of intersectMany(piece, siblingUnion)) {
        excluded.push({
          ...piece,
          start: hit.start,
          end: hit.end,
          reason,
          allocated_to: sibling.claim_id,
        });
      }
      remaining.push(...subtract(piece, siblingUnion));
    }
    pieces = remaining;
  }

  // 6. 远程办理手续按制度折算并按日封顶。
  const remote = policy.rules.remote_procedure ?? { count_ratio: 1, max_hours_per_day: 24 };
  const capMinutes = Math.round(remote.max_hours_per_day * 60);
  const remoteUsedByDay = new Map();
  const approved = [];
  for (const piece of pieces) {
    const gross = minutesBetween(piece);
    let counted = gross;
    if (piece.modality === "remote_procedure") {
      const ratioCounted = Math.round(gross * remote.count_ratio);
      if (ratioCounted < gross) {
        excluded.push({
          ...piece,
          reason: "remote_procedure_ratio",
          gross_minutes: gross,
          counted_minutes: ratioCounted,
          excluded_minutes: gross - ratioCounted,
        });
      }
      const used = remoteUsedByDay.get(piece.day) ?? 0;
      counted = Math.min(ratioCounted, Math.max(0, capMinutes - used));
      if (counted < ratioCounted) {
        excluded.push({
          ...piece,
          reason: "remote_daily_cap",
          gross_minutes: ratioCounted,
          counted_minutes: counted,
          excluded_minutes: ratioCounted - counted,
        });
      }
      remoteUsedByDay.set(piece.day, used + counted);
    }
    approved.push({ ...piece, gross_minutes: gross, counted_minutes: counted });
  }

  // 7. 仲裁恢复：指定原因的排除项按原时长恢复为核准。
  const reinstated = [];
  if (reinstateReasons.length > 0) {
    const kept = [];
    for (const item of excluded) {
      if (reinstateReasons.includes(item.reason) && item.start != null) {
        const minutes = minutesBetween(item);
        reinstated.push({
          ...item,
          gross_minutes: minutes,
          counted_minutes: minutes,
          reinstated: true,
        });
      } else {
        kept.push(item);
      }
    }
    excluded.length = 0;
    excluded.push(...kept);
  }

  const allApproved = [...approved, ...reinstated].sort((a, b) => a.start - b.start);
  const grossMinutes = allApproved.reduce((sum, piece) => sum + piece.gross_minutes, 0);
  const countedMinutes = allApproved.reduce((sum, piece) => sum + piece.counted_minutes, 0);
  const days = new Set(
    allApproved.filter((piece) => piece.counted_minutes > 0).map((piece) => piece.day),
  );

  return {
    approved: allApproved.map((piece) => formatApproved(piece, tzOffset)),
    excluded: excluded.map((item) => formatExcluded(item, tzOffset)),
    totals: {
      gross_minutes: grossMinutes,
      counted_minutes: countedMinutes,
      gross_hours: toHours(grossMinutes),
      counted_hours: toHours(countedMinutes),
      days: days.size,
    },
  };
}
