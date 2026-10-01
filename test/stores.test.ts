import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthError } from "../src/core/errors";
import { FileCredentialStore, FileNameCache, FileTokenStore, loadCredentials } from "../src/core/stores";

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
