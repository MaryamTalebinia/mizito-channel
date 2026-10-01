import { expect, test } from "bun:test";
import { AuthError, NetworkError, RateLimited, SchemaError } from "../src/core/errors";
import { MizitoClient } from "../src/core/client";
import { html, json, scriptedFetch } from "./helpers";

const credentials = { username: "u", password: "p" };
const tokenOf = (c: { init: RequestInit }) => (c.init.headers as Record<string, string>)["x-token"];

test("logs in lazily and sends x-token", async () => {
  const f = scriptedFetch([json({ status: 1, token: "T1" }), json({ ok: 1 })]);
  const c = new MizitoClient({ credentials, baseUrl: "https://x", fetch: f });
  expect(await c.post("/api/chat/getDialogs", {})).toEqual({ ok: 1 });
  expect(f.calls[0]!.url).toBe("https://x/capi/session/create");
  expect(f.calls[1]!.url).toBe("https://x/api/chat/getDialogs");
  expect(tokenOf(f.calls[1]!)).toBe("T1");
});

test("uses a provided token without logging in", async () => {
  const f = scriptedFetch([json({ ok: 1 })]);
  const c = new MizitoClient({ credentials, baseUrl: "https://x", fetch: f, token: "CACHED" });
  await c.post("/api/x");
  expect(f.calls).toHaveLength(1);
  expect(tokenOf(f.calls[0]!)).toBe("CACHED");
});

test("on 401 re-logs in once, retries, and reports the new token", async () => {
  const seen: string[] = [];
  const f = scriptedFetch([json({}, 401), json({ status: 1, token: "T2" }), json({ ok: 2 })]);
  const c = new MizitoClient({ credentials, baseUrl: "https://x", fetch: f, token: "OLD", onToken: (t) => { seen.push(t); } });
  expect(await c.post("/api/x")).toEqual({ ok: 2 });
  expect(tokenOf(f.calls[2]!)).toBe("T2");
  expect(seen).toEqual(["T2"]);
});

test("a second 401 after re-login is an AuthError, not a loop", async () => {
  const f = scriptedFetch([json({}, 401), json({ status: 1, token: "T2" }), json({}, 401)]);
  const c = new MizitoClient({ credentials, baseUrl: "https://x", fetch: f, token: "OLD" });
  await expect(c.post("/api/x")).rejects.toBeInstanceOf(AuthError);
  expect(f.calls).toHaveLength(3);
});

test("429 becomes RateLimited", async () => {
  const f = scriptedFetch([json({}, 429)]);
  const c = new MizitoClient({ credentials, baseUrl: "https://x", fetch: f, token: "T" });
  await expect(c.post("/api/x")).rejects.toBeInstanceOf(RateLimited);
});

test("a non-JSON body (maintenance page) becomes SchemaError", async () => {
  const f = scriptedFetch([html("<html>maintenance</html>")]);
  const c = new MizitoClient({ credentials, baseUrl: "https://x", fetch: f, token: "T" });
  await expect(c.post("/api/x")).rejects.toBeInstanceOf(SchemaError);
});

test("other HTTP errors and fetch failures become NetworkError", async () => {
  const c1 = new MizitoClient({ credentials, baseUrl: "https://x", fetch: scriptedFetch([json({}, 500)]), token: "T" });
  await expect(c1.post("/api/x")).rejects.toBeInstanceOf(NetworkError);
  const c2 = new MizitoClient({ credentials, baseUrl: "https://x", fetch: scriptedFetch([() => { throw new Error("down"); }]), token: "T" });
  await expect(c2.post("/api/x")).rejects.toBeInstanceOf(NetworkError);
});
