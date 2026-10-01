import { expect, test } from "bun:test";
import { hashPassword, login } from "../src/core/auth";
import { AuthError, NetworkError } from "../src/core/errors";
import { json, scriptedFetch } from "./helpers";

const creds = { username: "siamak", password: "abc" };

test("hashPassword is md5hex|sha256hex", () => {
  expect(hashPassword("abc")).toBe(
    "900150983cd24fb0d6963f7d28e17f72|ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("login posts hashed credentials and returns the token", async () => {
  const f = scriptedFetch([json({ status: 1, token: "T" })]);
  expect(await login(f, "https://x", creds)).toBe("T");
  expect(f.calls[0]!.url).toBe("https://x/capi/session/create");
  const body = JSON.parse(String(f.calls[0]!.init.body));
  expect(body.username).toBe("siamak");
  expect(body.password).toBe(hashPassword("abc"));
  expect(JSON.stringify(body)).not.toContain('"abc"');
});

test("status 5 also counts as success", async () => {
  expect(await login(scriptedFetch([json({ status: 5, token: "T5" })]), "https://x", creds)).toBe("T5");
});

test("rejected login throws AuthError without leaking the password", async () => {
  const f = scriptedFetch([json({ status: 0 })]);
  const err = await login(f, "https://x", creds).catch((e) => e);
  expect(err).toBeInstanceOf(AuthError);
  expect(String(err.message)).not.toContain("abc");
});

test("HTTP error on login throws AuthError", async () => {
  await expect(login(scriptedFetch([json({}, 500)]), "https://x", creds)).rejects.toBeInstanceOf(AuthError);
});

test("network failure on login throws NetworkError", async () => {
  const f = scriptedFetch([() => { throw new Error("boom"); }]);
  await expect(login(f, "https://x", creds)).rejects.toBeInstanceOf(NetworkError);
});
