import http from "node:http";
import { pathToFileURL } from "node:url";

import { bootstrapDemo } from "./bootstrap.js";
import { createRequestHandler } from "./http/app.js";

export const serviceId = "icu-family-evidence";
export const serviceName = "重症场外护理证据链";

export function healthPayload() {
  return { status: "ok", service: serviceId, name: serviceName };
}

// 装配演示用内存态依赖（签发方注册簿、员工、角色令牌）。
export function createDemoContext(options = {}) {
  return bootstrapDemo(options);
}

export function createServer(options = {}) {
  const context = options.context ?? bootstrapDemo(options).context;
  const handler = createRequestHandler(context, { healthPayload });
  return http.createServer(handler);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    if (healthPayload().service !== serviceId) process.exit(1);
    console.log("基础检查通过");
  } else {
    const portIndex = process.argv.indexOf("--port");
    const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 8000;
    createServer().listen(port, "0.0.0.0", () => {
      console.log(`${serviceName} 已启动，端口 ${port}`);
    });
  }
}
