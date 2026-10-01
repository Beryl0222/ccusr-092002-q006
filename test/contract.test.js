import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EVENT_KINDS, ISSUER_KINDS } from "../src/domain/credentials.js";
import { healthPayload, serviceId } from "../src/service.js";
import { buildPolicyBook, defaultPolicyVersions, LEAVE_KINDS } from "../src/domain/policy.js";

test("服务身份稳定", () => {
  assert.equal(healthPayload().service, serviceId);
});

test("时间线领域样例与服务一致", async () => {
  const raw = await readFile(new URL("../contracts/care_timeline.json", import.meta.url), "utf8");
  const data = JSON.parse(raw);
  assert.equal(data.service, serviceId);
  assert.ok(data.sample);
  assert.ok(data.sample.windows.care_window);
  assert.ok(data.sample.windows.icu_window);
  for (const event of data.sample.events) {
    assert.ok(EVENT_KINDS.has(event.kind), `样例事件类型须被凭证模块支持: ${event.kind}`);
    assert.ok(["on_site", "remote"].includes(event.presence));
    // 领域样例不得含诊断类字段。
    assert.ok(!JSON.stringify(event).includes("diagnosis"));
  }
  for (const kind of data.issuer_kinds) assert.ok(ISSUER_KINDS.has(kind));
});

test("制度契约文件与 policy.js 规则保持一致", async () => {
  const raw = await readFile(new URL("../contracts/policy.json", import.meta.url), "utf8");
  const data = JSON.parse(raw);
  const codeVersions = defaultPolicyVersions();
  assert.equal(data.versions.length, codeVersions.length);

  for (let i = 0; i < codeVersions.length; i += 1) {
    const fileVersion = data.versions[i];
    const codeVersion = codeVersions[i];
    assert.equal(fileVersion.id, codeVersion.id);
    assert.equal(fileVersion.effective_from, codeVersion.effective_from);
    assert.equal(fileVersion.rules.length, codeVersion.rules.length);
    for (const rule of codeVersion.rules) {
      assert.ok(LEAVE_KINDS.includes(rule.kind));
      const fileRule = fileVersion.rules.find((item) => item.kind === rule.kind);
      assert.ok(fileRule, `契约缺少规则 ${rule.kind} @ ${codeVersion.id}`);
      assert.equal(fileRule.pay_rate, rule.pay_rate);
      assert.equal(fileRule.max_calendar_days ?? null, rule.max_calendar_days ?? null);
      assert.equal(fileRule.daily_hours_cap, rule.daily_hours_cap ?? undefined);
    }
  }

  // 契约文件本身可被策略册加载（结构有效）。
  assert.doesNotThrow(() => buildPolicyBook(data.versions));
});
