import assert from "node:assert/strict";
import test from "node:test";

import { buildPolicyBook, defaultPolicyVersions } from "../src/domain/policy.js";
import { evaluateLeave } from "../src/domain/engine.js";

const book = buildPolicyBook(defaultPolicyVersions());

function cert({ start, end, events = [], icu = false }) {
  return {
    certificate_id: `CRT-${Math.random().toString(16).slice(2, 8)}`,
    facts: {
      care_window: { start, end },
      icu_window: icu ? { start, end } : null,
      events: events.map((kind, index) => ({
        ref: `EVT-${index}`,
        kind,
        occurred_at: start,
        presence: kind === "document_handling" ? "remote" : "on_site",
      })),
    },
  };
}

function run({ shifts, care, standby = [], annual = [], approved = [], relay = [], certificates }) {
  return evaluateLeave(
    {
      employee_id: "E1",
      hourly_rate: 50,
      shifts,
      declarations: {
        care: care.map((item) =>
          typeof item === "string" ? { start: item[0], end: item[1], mode: "on_site" } : item,
        ),
        standby,
      },
      annual_leave: annual,
      approved_intervals: approved,
      relay_conflicts: relay,
      certificates,
      now: "2025-06-10T10:00:00+08:00",
    },
    book,
  );
}

const shift = (id, start, end) => ({ id, start, end });

test("ICU 窗口内的班内缺勤认定为重症照护假并全薪", () => {
  const result = run({
    shifts: [shift("S1", "2025-06-02T08:00:00+08:00", "2025-06-02T20:00:00+08:00")],
    care: [{ start: "2025-06-02T08:00:00+08:00", end: "2025-06-02T20:00:00+08:00", mode: "on_site" }],
    certificates: [
      cert({
        start: "2025-06-02T00:00:00+08:00",
        end: "2025-06-03T00:00:00+08:00",
        events: ["admission", "critical_notice"],
        icu: true,
      }),
    ],
  });
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].leave_kind, "icu_care_leave");
  assert.equal(result.segments[0].minutes, 720);
  assert.equal(result.segments[0].pay_amount, 600);
});

test("跨午夜班次按本地日拆分，分别归入两天", () => {
  const result = run({
    shifts: [shift("S1", "2025-06-03T20:00:00+08:00", "2025-06-04T08:00:00+08:00")],
    care: [{ start: "2025-06-03T20:00:00+08:00", end: "2025-06-04T08:00:00+08:00", mode: "on_site" }],
    certificates: [
      cert({
        start: "2025-06-03T00:00:00+08:00",
        end: "2025-06-05T00:00:00+08:00",
        events: ["admission"],
        icu: true,
      }),
    ],
  });
  assert.deepEqual(result.segments.map((s) => s.day), ["2025-06-03", "2025-06-04"]);
  assert.equal(result.segments[0].minutes, 240);
  assert.equal(result.segments[1].minutes, 480);
});

test("远程办理手续认定为远程办公", () => {
  const result = run({
    shifts: [shift("S1", "2025-06-10T09:00:00+08:00", "2025-06-10T18:00:00+08:00")],
    care: [{ start: "2025-06-10T10:00:00+08:00", end: "2025-06-10T12:00:00+08:00", mode: "remote" }],
    certificates: [
      cert({
        start: "2025-06-10T00:00:00+08:00",
        end: "2025-06-11T00:00:00+08:00",
        events: ["document_handling"],
      }),
    ],
  });
  assert.equal(result.segments[0].leave_kind, "remote_work");
});

test("无凭证支持的缺勤兜底为事假且不付薪", () => {
  const result = run({
    shifts: [shift("S1", "2025-06-10T09:00:00+08:00", "2025-06-10T18:00:00+08:00")],
    care: [{ start: "2025-06-10T10:00:00+08:00", end: "2025-06-10T12:00:00+08:00", mode: "on_site" }],
    certificates: [],
  });
  assert.equal(result.segments[0].leave_kind, "personal_affairs");
  assert.equal(result.segments[0].unsubstantiated, true);
  assert.equal(result.segments[0].pay_amount, 0);
});

test("与已排定年假重叠的时间按年假排除，不另增照护假", () => {
  const result = run({
    shifts: [shift("S1", "2025-06-03T08:00:00+08:00", "2025-06-04T08:00:00+08:00")],
    care: [{ start: "2025-06-03T08:00:00+08:00", end: "2025-06-04T08:00:00+08:00", mode: "on_site" }],
    annual: [{ start: "2025-06-03T00:00:00+08:00", end: "2025-06-04T00:00:00+08:00" }],
    certificates: [
      cert({
        start: "2025-06-03T00:00:00+08:00",
        end: "2025-06-05T00:00:00+08:00",
        events: ["admission"],
        icu: true,
      }),
    ],
  });
  const annualExcluded = result.exclusions.filter((e) => e.reason === "annual_leave_overlap");
  assert.ok(annualExcluded.length >= 1);
  // 年假覆盖 06-03 全天，照护片段只应落在 06-04。
  assert.ok(result.segments.every((s) => s.day === "2025-06-04"));
});

test("与既往已核准区间重叠的申报被排除，重复上传不增加假期", () => {
  const result = run({
    shifts: [shift("S1", "2025-06-02T08:00:00+08:00", "2025-06-02T20:00:00+08:00")],
    care: [{ start: "2025-06-02T08:00:00+08:00", end: "2025-06-02T20:00:00+08:00", mode: "on_site" }],
    approved: [
      {
        start: "2025-06-02T08:00:00+08:00",
        end: "2025-06-02T20:00:00+08:00",
        claim_id: "CLM-OLD",
      },
    ],
    certificates: [
      cert({ start: "2025-06-02T00:00:00+08:00", end: "2025-06-03T00:00:00+08:00", events: ["admission"], icu: true }),
    ],
  });
  assert.equal(result.segments.length, 0);
  assert.equal(result.exclusions[0].reason, "duplicate_claim");
  assert.equal(result.exclusions[0].detail.includes("CLM-OLD"), true);
});

test("重症照护假额度按本地日计，超出后降级为家庭照护假再到事假", () => {
  // 连续 7 个排班日，每天 8 小时班 + 8 小时照护缺勤。
  const days = ["06-02", "06-03", "06-04", "06-05", "06-06", "06-07", "06-08"];
  const result = run({
    shifts: days.map((d) => shift(`S-${d}`, `2025-${d}T08:00:00+08:00`, `2025-${d}T16:00:00+08:00`)),
    care: days.map((d) => ({
      start: `2025-${d}T08:00:00+08:00`,
      end: `2025-${d}T16:00:00+08:00`,
      mode: "on_site",
    })),
    certificates: [
      cert({
        start: "2025-06-02T00:00:00+08:00",
        end: "2025-06-09T00:00:00+08:00",
        events: ["admission"],
        icu: true,
      }),
    ],
  });
  const byKind = result.segments.reduce((acc, s) => {
    acc[s.leave_kind] = (acc[s.leave_kind] ?? 0) + 1;
    return acc;
  }, {});
  assert.equal(byKind.icu_care_leave, 5);
  // 第 6、7 天：无家庭照护事件支持 → 事假兜底。
  assert.equal(byKind.personal_affairs, 2);
  const quota = result.quota.find((q) => q.kind === "icu_care_leave");
  assert.equal(quota.calendar_days_used.length, 5);
  assert.equal(quota.max_calendar_days, 5);
});

test("家庭照护假日 8 小时上限封顶，超出部分列入排除", () => {
  const result = run({
    shifts: [shift("S1", "2025-06-09T08:00:00+08:00", "2025-06-10T08:00:00+08:00")],
    care: [{ start: "2025-06-09T08:00:00+08:00", end: "2025-06-10T08:00:00+08:00", mode: "on_site" }],
    certificates: [
      cert({
        start: "2025-06-09T00:00:00+08:00",
        end: "2025-06-10T00:00:00+08:00",
        events: ["discharge"],
      }),
    ],
  });
  const day09 = result.segments.find((s) => s.day === "2025-06-09");
  assert.equal(day09.leave_kind, "family_care_leave");
  assert.equal(day09.minutes, 960);
  assert.equal(day09.billable_minutes, 480); // 8 小时封顶
  assert.ok(result.exclusions.some((e) => e.reason === "daily_hours_cap"));
});

test("跨制度版本（2025→2026）的照护按当期制度分别核算", () => {
  const result = run({
    shifts: [
      shift("S1", "2025-12-31T20:00:00+08:00", "2026-01-01T08:00:00+08:00"),
    ],
    care: [{ start: "2025-12-31T20:00:00+08:00", end: "2026-01-01T08:00:00+08:00", mode: "on_site" }],
    certificates: [
      cert({
        start: "2025-12-31T00:00:00+08:00",
        end: "2026-01-02T00:00:00+08:00",
        events: ["admission"],
        icu: true,
      }),
    ],
  });
  assert.deepEqual(
    result.segments.map((s) => [s.day, s.policy_id]),
    [
      ["2025-12-31", "POL-2025"],
      ["2026-01-01", "POL-2026"],
    ],
  );
  assert.deepEqual(result.policy_versions.map((p) => p.policy_id).sort(), ["POL-2025", "POL-2026"]);
});

test("待命时段不计缺勤，请求发出后覆盖跨午夜片段", () => {
  const result = run({
    shifts: [],
    care: [],
    standby: [{ start: "2025-06-04T20:00:00+08:00", end: "2025-06-05T02:00:00+08:00" }],
    certificates: [
      {
        certificate_id: "CRT-STBY",
        facts: {
          care_window: { start: "2025-06-04T00:00:00+08:00", end: "2025-06-05T12:00:00+08:00" },
          icu_window: null,
          events: [
            { ref: "EVT-S", kind: "standby_request", occurred_at: "2025-06-04T21:00:00+08:00", presence: "on_site" },
          ],
        },
      },
    ],
  });
  assert.equal(result.segments.length, 0);
  assert.equal(result.standby.length, 2);
  assert.deepEqual(result.standby.map((s) => s.day), ["2025-06-04", "2025-06-05"]);
  assert.ok(result.standby.every((s) => s.substantiated));
});

test("亲属轮换冲突片段挂起，不计入应付", () => {
  const result = run({
    shifts: [shift("S1", "2025-06-02T08:00:00+08:00", "2025-06-02T20:00:00+08:00")],
    care: [{ start: "2025-06-02T08:00:00+08:00", end: "2025-06-02T20:00:00+08:00", mode: "on_site" }],
    relay: [{ start: "2025-06-02T08:00:00+08:00", end: "2025-06-02T20:00:00+08:00", with_employee: "E2" }],
    certificates: [
      cert({ start: "2025-06-02T00:00:00+08:00", end: "2025-06-03T00:00:00+08:00", events: ["admission"], icu: true }),
    ],
  });
  assert.equal(result.segments[0].relay_pending, true);
  assert.equal(result.segments[0].relay_with, "E2");
  assert.equal(result.segments[0].pay_amount, 0);
  assert.equal(result.totals.pending_minutes, 720);
  assert.equal(result.totals.payable_amount, 0);
});
