import http from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { reconstructFromPayrollAdjustment } from "./lib/audit.js";
import { disclosurePreview } from "./lib/disclosure.js";
import { fail } from "./lib/errors.js";
import {
  applyArbitration,
  applyProofCorrection,
  decideClaim,
  fileClaim,
  postPayrollAdjustment,
} from "./lib/ledger.js";
import { issueProof, registerIssuer, verifyProof } from "./lib/proofs.js";
import { createStore, loadTimeline } from "./lib/store.js";
import { disputeView, grantAccess, payrollView, supervisorView } from "./lib/views.js";

export const serviceId = "icu-family-evidence";
export const serviceName = "重症场外护理证据链";

export function healthPayload() {
  return { status: "ok", service: serviceId, name: serviceName };
}

// 启动时装载公开契约样例中的个案时间线（不含真实个人资料）。
function loadContractTimeline(store) {
  try {
    const raw = readFileSync(new URL("../contracts/care_timeline.json", import.meta.url), "utf8");
    const data = JSON.parse(raw);
    if (data?.sample?.case_id) {
      loadTimeline(store, { case_id: data.sample.case_id, ...data.sample });
    }
  } catch {
    // 样例缺失不影响服务启动
  }
}

const routes = [
  { method: "GET", pattern: "/health", handler: () => healthPayload() },
  { method: "POST", pattern: "/issuers", handler: (store, body) => registerIssuer(store, body) },
  { method: "POST", pattern: "/proofs", handler: (store, body) => issueProof(store, body) },
  { method: "GET", pattern: "/proofs/:id/verify", handler: (store, _body, params) => verifyProof(store, params.id) },
  { method: "POST", pattern: "/proofs/:id/corrections", handler: (store, body, params) => applyProofCorrection(store, params.id, body) },
  { method: "POST", pattern: "/claims", handler: (store, body) => fileClaim(store, body) },
  { method: "POST", pattern: "/claims/:id/decisions", handler: (store, body, params) => decideClaim(store, params.id, body) },
  { method: "POST", pattern: "/cases/:id/arbitrations", handler: (store, body, params) => applyArbitration(store, params.id, body) },
  { method: "POST", pattern: "/cases/:id/authorizations", handler: (store, body, params) => grantAccess(store, { ...body, case_id: params.id }) },
  { method: "GET", pattern: "/claims/:id/views/supervisor", handler: (store, _body, params) => supervisorView(store, params.id) },
  { method: "GET", pattern: "/claims/:id/views/payroll", handler: (store, _body, params) => payrollView(store, params.id) },
  { method: "GET", pattern: "/cases/:id/views/dispute", handler: (store, _body, params, req) => disputeView(store, params.id, req.headers["x-grantee"]) },
  { method: "GET", pattern: "/claims/:id/disclosure-preview", handler: (store, _body, params, _req, query) => disclosurePreview(store, params.id, query.get("audience")) },
  { method: "POST", pattern: "/payroll-adjustments", handler: (store, body) => postPayrollAdjustment(store, body) },
  { method: "GET", pattern: "/payroll-adjustments/:id/reconstruction", handler: (store, _body, params) => reconstructFromPayrollAdjustment(store, params.id) },
];

function matchRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const routeParts = route.pattern.split("/").filter(Boolean);
    const pathParts = pathname.split("/").filter(Boolean);
    if (routeParts.length !== pathParts.length) continue;
    const params = {};
    let matched = true;
    for (let index = 0; index < routeParts.length; index += 1) {
      if (routeParts[index].startsWith(":")) {
        params[routeParts[index].slice(1)] = decodeURIComponent(pathParts[index]);
      } else if (routeParts[index] !== pathParts[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return null;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail(400, "请求体不是合法 JSON");
  }
}

export function createServer({ store = createStore() } = {}) {
  if (store.timelines.size === 0) loadContractTimeline(store);
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    };
    const matched = matchRoute(req.method, url.pathname);
    if (!matched) {
      send(404, { error: "未找到资源" });
      return;
    }
    try {
      const body = req.method === "GET" ? {} : await readBody(req);
      const result = matched.route.handler(store, body, matched.params, req, url.searchParams);
      send(200, result ?? {});
    } catch (error) {
      send(error.status ?? 500, { error: error.message });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    if (healthPayload().service !== serviceId) process.exit(1);
    if (createStore().policies.length === 0) process.exit(1);
    console.log("基础检查通过");
  } else {
    const portIndex = process.argv.indexOf("--port");
    const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 8000;
    createServer().listen(port, "0.0.0.0");
  }
}
