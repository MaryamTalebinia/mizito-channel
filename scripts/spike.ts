import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MIZITO_BASE_URL ?? "https://app.mizito.ir";
const username = process.env.MIZITO_USERNAME;
const password = process.env.MIZITO_PASSWORD;
if (!username || !password) throw new Error("set MIZITO_USERNAME and MIZITO_PASSWORD");

const md5 = createHash("md5").update(password).digest("hex");
const sha = createHash("sha256").update(password).digest("hex");

function shape(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.length ? [`array(${v.length})`, shape(v[0], depth + 1)] : "array(0)";
  if (v && typeof v === "object") {
    if (depth > 3) return "object";
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
  }
  return v === null ? "null" : typeof v;
}

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-token": token } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text };
}

mkdirSync("spike-output", { recursive: true });

const login = await post("/capi/session/create", {
  username, password: `${md5}|${sha}`, loginCode: "", regId: "",
});
console.log("login http", login.status, "body shape", JSON.stringify(shape(login.json)));
const token = (login.json as { token?: string } | undefined)?.token;
if (!token) throw new Error("no token; login needs a different request (2FA? regId?)");

const parts = token.split(".");
if (parts.length === 3) {
  const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
  console.log("token is a JWT; payload keys:", Object.keys(payload));
} else {
  console.log("token is opaque");
}

const dialogs = await post("/api/chat/getDialogs", {}, token);
console.log("getDialogs http", dialogs.status, JSON.stringify(shape(dialogs.json), null, 1));
writeFileSync("spike-output/dialogs.json", dialogs.text, { mode: 0o600 });

const first = (dialogs.json as { dialogs?: { _id: string }[] } | undefined)?.dialogs?.[0];
if (first) {
  const h = await post("/api/chat/getHistory", { dialog: first._id, offset: 0 }, token);
  console.log("getHistory http", h.status, JSON.stringify(shape(h.json), null, 1));
  writeFileSync("spike-output/history.json", h.text, { mode: 0o600 });
}
