// 披露预览：员工在提交前可以看到"系统将向某个角色披露哪些字段"。
// 预览直接复用各角色视图的投影逻辑，保证预览与实际披露一致。
import { fail } from "./errors.js";
import { buildDisputePayload, payrollView, supervisorView } from "./views.js";

const AUDIENCES = new Set(["supervisor", "payroll", "dispute_handler"]);

function flatten(value, path = "", out = []) {
  if (Array.isArray(value)) {
    if (value.length === 0) out.push({ path, value: [] });
    value.forEach((item, index) => flatten(item, `${path}[${index}]`, out));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      flatten(item, path ? `${path}.${key}` : key, out);
    }
  } else {
    out.push({ path, value });
  }
  return out;
}

export function disclosurePreview(store, claimId, audience) {
  const claim = store.claims.get(claimId);
  if (!claim) fail(404, `请假申请不存在: ${claimId}`);
  if (!AUDIENCES.has(audience)) fail(400, `未知披露对象: ${audience}`);
  let view;
  if (audience === "supervisor") view = supervisorView(store, claimId);
  if (audience === "payroll") {
    try {
      view = payrollView(store, claimId);
    } catch (error) {
      if (error.status !== 409) throw error;
      view = { employee_id: claim.employee_id, claim_id: claim.claim_id, note: "尚无核准决定" };
    }
  }
  // 争议处理人视图预览的是"经授权后对方将看到的内容"，预览本身不需要授权。
  if (audience === "dispute_handler") view = buildDisputePayload(store, claim.case_id);
  return {
    claim_id: claimId,
    audience,
    disclosed_fields: flatten(view),
    guarantees: [
      "证明与视图均不含诊断、病历等医疗细节",
      "重复上传的凭证与时段不会增加假期",
      "预览字段与实际向该角色披露的内容一致",
    ],
  };
}
