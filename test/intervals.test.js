import assert from "node:assert/strict";
import test from "node:test";

import {
  asInterval,
  intersectMany,
  isoInZone,
  minutesBetween,
  splitAtCalendarDays,
  subtract,
  unionMerge,
} from "../src/lib/intervals.js";

test("区间减法保留剩余部分", () => {
  const base = asInterval({ start: "2025-06-03T08:00:00+08:00", end: "2025-06-03T20:00:00+08:00" });
  const block = asInterval({ start: "2025-06-03T12:00:00+08:00", end: "2025-06-03T14:00:00+08:00" });
  const rest = subtract(base, [block]);
  assert.equal(rest.length, 2);
  assert.deepEqual(
    rest.map((piece) => minutesBetween(piece)),
    [240, 360],
  );
});

test("交集计算支持多个区间", () => {
  const piece = asInterval({ start: "2025-06-03T08:00:00+08:00", end: "2025-06-03T20:00:00+08:00" });
  const hits = intersectMany(piece, [
    asInterval({ start: "2025-06-03T06:00:00+08:00", end: "2025-06-03T10:00:00+08:00" }),
    asInterval({ start: "2025-06-03T18:00:00+08:00", end: "2025-06-03T22:00:00+08:00" }),
  ]);
  assert.equal(hits.length, 2);
  assert.equal(hits.reduce((sum, hit) => sum + minutesBetween(hit), 0), 240);
});

test("并集合并只在指定时合并首尾相接区间", () => {
  const intervals = [
    asInterval({ start: "2025-06-03T08:00:00+08:00", end: "2025-06-03T12:00:00+08:00" }),
    asInterval({ start: "2025-06-03T12:00:00+08:00", end: "2025-06-03T16:00:00+08:00" }),
  ];
  assert.equal(unionMerge(intervals).length, 2);
  assert.equal(unionMerge(intervals, { mergeTouching: true }).length, 1);
});

test("跨午夜待命按自然日拆段", () => {
  const interval = asInterval({ start: "2025-06-03T20:00:00+08:00", end: "2025-06-04T08:00:00+08:00" });
  const pieces = splitAtCalendarDays(interval, 480);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].day, "2025-06-03");
  assert.equal(minutesBetween(pieces[0]), 240);
  assert.equal(pieces[1].day, "2025-06-04");
  assert.equal(minutesBetween(pieces[1]), 480);
});

test("时区化输出与解析往返一致", () => {
  const ms = Date.parse("2025-06-03T20:00:00+08:00");
  assert.equal(isoInZone(ms, 480), "2025-06-03T20:00:00+08:00");
  assert.equal(Date.parse(isoInZone(ms, 480)), ms);
});
