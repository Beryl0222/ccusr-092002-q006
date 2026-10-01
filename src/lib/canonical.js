import crypto from "node:crypto";

// 规范化序列化：键排序后的紧凑 JSON，保证同一内容得到同一串字节，
// 是签名与内容去重哈希的共同基础。
export function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256hex(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function hmacSha256hex(text, key) {
  return crypto.createHmac("sha256", key).update(text).digest("hex");
}

export function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
