import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthError } from "../src/core/errors";
import { FileCredentialStore, FileNameCache, FileTokenStore, LoginThrottle, loadCredentials } from "../src/core/stores";

const tmp = () => mkdtemp(join(tmpdir(), "mizito-"));

test("credential store round-trips and writes mode 0600", async () => {
  const path = join(await tmp(), "nested", "credentials.json");
  const s = new FileCredentialStore(path);
  expect(await s.get()).toBeUndefined();
  await s.set({ username: "u", password: "p" });
  expect(await s.get()).toEqual({ username: "u", password: "p" });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("token store round-trips and writes mode 0600", async () => {
  const path = join(await tmp(), "session.json");
  const s = new FileTokenStore(path);
  expect(await s.get()).toBeUndefined();
  await s.set("TOKEN");
  expect(await s.get()).toBe("TOKEN");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ token: "TOKEN" });
});

test("corrupt files read as empty rather than throwing", async () => {
  const path = join(await tmp(), "session.json");
  await Bun.write(path, "{not json");
  expect(await new FileTokenStore(path).get()).toBeUndefined();
  expect(await new FileCredentialStore(path).get()).toBeUndefined();
});

test("loadCredentials prefers env, then the store, else AuthError", async () => {
  const store = { get: async () => ({ username: "stored", password: "sp" }) };
  expect(await loadCredentials({ MIZITO_USERNAME: "e", MIZITO_PASSWORD: "ep" }, store)).toEqual({ username: "e", password: "ep" });
  expect(await loadCredentials({}, store)).toEqual({ username: "stored", password: "sp" });
  await expect(loadCredentials({}, { get: async () => undefined })).rejects.toBeInstanceOf(AuthError);
  await expect(loadCredentials({ MIZITO_USERNAME: "only-user" })).rejects.toBeInstanceOf(AuthError);
});

test("name cache persists names only after save and tolerates a corrupt file", async () => {
  const path = join(await tmp(), "names.json");
  const a = await FileNameCache.open(path);
  a.set("d1", "علی رضا");
  expect((await FileNameCache.open(path)).get("d1")).toBeUndefined();
  await a.save();
  expect((await FileNameCache.open(path)).get("d1")).toBe("علی رضا");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await Bun.write(path, "garbage");
  expect((await FileNameCache.open(path)).get("d1")).toBeUndefined();
});

test("login throttle allows 3 logins per window, refuses the 4th, and recovers", async () => {
  const path = join(await tmp(), "logins.json");
  let t = 1_000_000;
  const th = new LoginThrottle(path, { max: 3, windowMs: 600_000, now: () => t });
  await th.check(); await th.check(); await th.check();
  const err = await th.check().catch((e) => e);
  expect(err).toBeInstanceOf(AuthError);
  expect(err.message).toMatch(/throttled/i);
  t += 600_001;
  await th.check(); // window passed
});

test("login throttle persists across instances and tolerates a corrupt file", async () => {
  const path = join(await tmp(), "logins.json");
  const now = () => 5_000;
  await new LoginThrottle(path, { max: 1, windowMs: 1000, now }).check();
  await expect(new LoginThrottle(path, { max: 1, windowMs: 1000, now }).check()).rejects.toBeInstanceOf(AuthError);
  await Bun.write(path, "garbage");
  await new LoginThrottle(path, { max: 1, windowMs: 1000, now }).check();
});
