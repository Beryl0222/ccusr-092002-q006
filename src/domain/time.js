// 时间区间工具：所有时刻均使用带偏移的 ISO-8601 字符串，区间为 [start, end) 半开区间。
// 本地日按制度给定的固定 UTC 偏移切分（样例使用 Asia/Shanghai +08:00）。

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export function parseInstant(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`无法解析时刻: ${String(iso)}`);
  }
  return ms;
}

export function toIso(ms) {
  return new Date(ms).toISOString();
}

// 按固定 UTC 偏移格式化，保证跨午夜边界显示为本地挂钟时间（如 +08:00）。
export function toIsoOffset(ms, offsetMinutes) {
  const shifted = new Date(ms + offsetMinutes * MINUTE_MS).toISOString();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${shifted.slice(0, 19)}${sign}${hh}:${mm}`;
}

export function minutesBetween(startIso, endIso) {
  return Math.round((parseInstant(endIso) - parseInstant(startIso)) / MINUTE_MS);
}

export function isValidInterval(interval) {
  if (!interval || typeof interval !== "object") return false;
  try {
    return parseInstant(interval.end) > parseInstant(interval.start);
  } catch {
    return false;
  }
}

export function asInterval(value) {
  if (!isValidInterval(value)) {
    throw Object.assign(new Error(`区间无效: ${JSON.stringify(value)}`), { code: "invalid_request" });
  }
  return { start: value.start, end: value.end };
}

// 把毫秒时刻转换为制度本地日字符串 YYYY-MM-DD。
export function localDayOf(ms, offsetMinutes) {
  const shifted = new Date(ms + offsetMinutes * MINUTE_MS);
  return shifted.toISOString().slice(0, 10);
}

// 某一本地日 00:00 对应的 UTC 毫秒。
export function localDayStart(dayString, offsetMinutes) {
  const ms = Date.parse(`${dayString}T00:00:00.000Z`);
  if (Number.isNaN(ms)) throw new Error(`无法解析日期: ${dayString}`);
  return ms - offsetMinutes * MINUTE_MS;
}

// 按本地日边界切分区间，返回 [{day, start, end}]，跨午夜的班次/待命由此拆开。
export function splitByLocalDay(interval, offsetMinutes) {
  asInterval(interval);
  let cursor = parseInstant(interval.start);
  const end = parseInstant(interval.end);
  const pieces = [];
  while (cursor < end) {
    const day = localDayOf(cursor, offsetMinutes);
    const nextMidnight = localDayStart(day, offsetMinutes) + DAY_MS;
    const pieceEnd = Math.min(end, nextMidnight);
    pieces.push({ day, start: toIsoOffset(cursor, offsetMinutes), end: toIsoOffset(pieceEnd, offsetMinutes) });
    cursor = pieceEnd;
  }
  return pieces;
}

export function intersect(a, b) {
  const start = Math.max(parseInstant(a.start), parseInstant(b.start));
  const end = Math.min(parseInstant(a.end), parseInstant(b.end));
  if (start >= end) return null;
  return { start: toIso(start), end: toIso(end) };
}

// 从 interval 中抠掉 blockers 覆盖的部分，返回剩余区间列表。
export function subtract(interval, blockers) {
  let remain = [asInterval(interval)];
  for (const rawBlocker of blockers) {
    const blocker = asInterval(rawBlocker);
    const next = [];
    for (const piece of remain) {
      const overlap = intersect(piece, blocker);
      if (!overlap) {
        next.push(piece);
        continue;
      }
      if (parseInstant(piece.start) < parseInstant(overlap.start)) {
        next.push({ start: piece.start, end: overlap.start });
      }
      if (parseInstant(overlap.end) < parseInstant(piece.end)) {
        next.push({ start: overlap.end, end: piece.end });
      }
    }
    remain = next;
  }
  return remain;
}

export function unionMerge(intervals) {
  const sorted = intervals
    .filter(isValidInterval)
    .map((item) => ({ start: parseInstant(item.start), end: parseInstant(item.end) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (last && item.start <= last.end) {
      last.end = Math.max(last.end, item.end);
    } else {
      merged.push({ ...item });
    }
  }
  return merged.map((item) => ({ start: toIso(item.start), end: toIso(item.end) }));
}

export function isInsideAny(interval, windows) {
  return windows.some((window) => {
    const end = window.end ? parseInstant(window.end) : Infinity;
    return (
      parseInstant(interval.start) >= parseInstant(window.start) &&
      parseInstant(interval.end) <= end
    );
  });
}

export function roundMoney(amount) {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}
