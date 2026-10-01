// 半开区间 [start, end) 代数：所有照护时段、证明覆盖区间、年假区间
// 都归一到毫秒时间戳上运算，输出时再按制度时区格式化。
import { fail } from "./errors.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export function asDate(input) {
  if (input instanceof Date) return input;
  return new Date(input ?? Date.now());
}

export function parseMs(iso, field = "时间") {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) fail(400, `${field}不是合法时间: ${iso}`);
  return ms;
}

export function asInterval(input, field = "区间") {
  if (!input || typeof input !== "object") fail(400, `${field}缺失`);
  const start = parseMs(input.start, `${field}.start`);
  const end = parseMs(input.end, `${field}.end`);
  if (!(start < end)) fail(400, `${field}的起止时间无效`);
  return { start, end };
}

export function minutesBetween(interval) {
  return Math.round((interval.end - interval.start) / MINUTE_MS);
}

export function toHours(minutes) {
  return Math.round((minutes / 60) * 100) / 100;
}

export function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

export function intersect(a, b) {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start < end ? { start, end } : null;
}

// base 减去 blocks 后剩下的部分；保留 base 上携带的额外字段（如 modality）。
export function subtract(base, blocks) {
  let rest = [base];
  for (const block of blocks) {
    const next = [];
    for (const piece of rest) {
      if (!overlaps(piece, block)) {
        next.push(piece);
        continue;
      }
      if (piece.start < block.start) {
        next.push({ ...piece, end: Math.min(block.start, piece.end) });
      }
      if (block.end < piece.end) {
        next.push({ ...piece, start: Math.max(block.end, piece.start) });
      }
    }
    rest = next;
  }
  return rest.filter((piece) => piece.start < piece.end);
}

export function subtractMany(pieces, blocks) {
  return pieces.flatMap((piece) => subtract(piece, blocks));
}

// 并集合并。mergeTouching 用于覆盖区间这类"首尾相接也算连续"的场景；
// 默认只合并真正重叠的区间，不跨过午夜等边界。
export function unionMerge(intervals, { mergeTouching = false } = {}) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    const touches = mergeTouching ? interval.start <= last?.end : interval.start < last?.end;
    if (last && touches) {
      if (interval.end > last.end) last.end = interval.end;
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

// piece 与 blocks 的交集列表（blocks 先并集化，避免重复计数）。
export function intersectMany(piece, blocks) {
  const hits = [];
  for (const block of unionMerge(blocks, { mergeTouching: true })) {
    const hit = intersect(piece, block);
    if (hit) hits.push(hit);
  }
  return hits;
}

export function dayKey(ms, offsetMinutes) {
  return new Date(ms + offsetMinutes * MINUTE_MS).toISOString().slice(0, 10);
}

// 跨午夜待命按自然日拆段：每段都落在同一日历日内并标注 day。
export function splitAtCalendarDays(interval, offsetMinutes) {
  const pieces = [];
  let cursor = interval.start;
  while (cursor < interval.end) {
    const shifted = cursor + offsetMinutes * MINUTE_MS;
    const dayStartShifted = Math.floor(shifted / DAY_MS) * DAY_MS;
    const nextBoundary = dayStartShifted + DAY_MS - offsetMinutes * MINUTE_MS;
    const end = Math.min(interval.end, nextBoundary);
    pieces.push({ ...interval, start: cursor, end, day: dayKey(cursor, offsetMinutes) });
    cursor = end;
  }
  return pieces;
}

export function isoInZone(ms, offsetMinutes = 0) {
  const shifted = new Date(ms + offsetMinutes * MINUTE_MS);
  const base = shifted.toISOString().slice(0, 19);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${base}${sign}${hh}:${mm}`;
}
