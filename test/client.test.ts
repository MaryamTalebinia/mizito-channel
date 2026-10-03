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

test("beforeLogin runs before every login, and its failure prevents the login request", async () => {
  let calls = 0;
  const f = scriptedFetch([json({ status: 1, token: "T" }), json({ ok: 1 })]);
  const c = new MizitoClient({ credentials, baseUrl: "https://x", fetch: f, beforeLogin: async () => { calls++; } });
  await c.post("/api/x");
  expect(calls).toBe(1);

  const f2 = scriptedFetch([]);
  const blocked = new MizitoClient({
    credentials, baseUrl: "https://x", fetch: f2,
    beforeLogin: async () => { throw new AuthError("Login throttled"); },
  });
  await expect(blocked.post("/api/x")).rejects.toBeInstanceOf(AuthError);
  expect(f2.calls).toHaveLength(0);
});

test("upload uses the web client's multipart shape", async () => {
  const media = { _: "messageMediaDocument", document: { name: "report.pdf" } };
  const f = scriptedFetch([json(media)]);
  const c = new MizitoClient({ credentials, baseUrl: "https://x", fetch: f, token: "T" });
  expect(await c.upload("report.pdf", new Blob(["pdf"]), "application/pdf")).toEqual(media);
  const call = f.calls[0]!;
  expect(call.url).toBe("https://x/api/content/upload");
  expect(call.init.method).toBe("POST");
  expect(tokenOf(call)).toBe("T");
  expect((call.init.headers as Record<string, string>)["content-type"]).toBeUndefined();
  const form = call.init.body as FormData;
  expect(form.get("sendAsFile")).toBe("true");
  const file = form.get("upload") as File;
  expect(file.name).toBe("report.pdf");
  expect(file.type).toBe("application/pdf");
  expect(await file.text()).toBe("pdf");
});

test("upload shares lazy login, one 401 retry, rate-limit, and JSON handling", async () => {
  const f = scriptedFetch([
    json({ status: 1, token: "T1" }), json({}, 401),
    json({ status: 1, token: "T2" }), json({ _: "messageMediaDocument" }),
  ]);
  const c = new MizitoClient({ credentials, baseUrl: "https://x", fetch: f });
  await c.upload("a.txt", new Blob(["a"]), "text/plain");
  expect(tokenOf(f.calls[1]!)).toBe("T1");
  expect(tokenOf(f.calls[3]!)).toBe("T2");
  const limited = new MizitoClient({ credentials, baseUrl: "https://x", fetch: scriptedFetch([json({}, 429)]), token: "T" });
  await expect(limited.upload("a", new Blob(), "application/octet-stream")).rejects.toBeInstanceOf(RateLimited);
  const invalid = new MizitoClient({ credentials, baseUrl: "https://x", fetch: scriptedFetch([html("no")]), token: "T" });
  await expect(invalid.upload("a", new Blob(), "application/octet-stream")).rejects.toBeInstanceOf(SchemaError);
});

test("upload errors never disclose the session token", async () => {
  const token = "TOP-SECRET-TOKEN";
  const f = scriptedFetch([() => { throw new Error(`failed with ${token}`); }]);
  const c = new MizitoClient({ credentials, baseUrl: "https://x", fetch: f, token });
  try {
    await c.upload("a", new Blob(), "application/octet-stream");
    throw new Error("expected upload failure");
  } catch (e) {
    expect(String(e)).not.toContain(token);
    expect(e).toBeInstanceOf(NetworkError);
  }
});
