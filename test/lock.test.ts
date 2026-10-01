import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../src/core/errors";
import { PidLock } from "../src/core/lock";

const tmpPath = async () => join(await mkdtemp(join(tmpdir(), "mizito-")), "sub", "watcher.lock");

test("acquire writes our pid and release removes the file", async () => {
  const path = await tmpPath();
  const lock = new PidLock(path, { pid: 111 });
  await lock.acquire();
  expect((await readFile(path, "utf8")).trim()).toBe("111");
  lock.release();
  expect(existsSync(path)).toBe(false);
});

test("a live holder blocks a second acquirer with a clear error", async () => {
  const path = await tmpPath();
  await new PidLock(path, { pid: 111 }).acquire();
  const err = await new PidLock(path, { pid: 222, isAlive: () => true }).acquire().catch((e) => e);
  expect(err).toBeInstanceOf(ConfigError);
  expect(err.message).toContain("111");
});

test("a stale lock from a dead process is taken over", async () => {
  const path = await tmpPath();
  await new PidLock(path, { pid: 111 }).acquire();
  await new PidLock(path, { pid: 222, isAlive: () => false }).acquire();
  expect((await readFile(path, "utf8")).trim()).toBe("222");
});

test("re-acquiring our own lock is fine, and release by a non-holder leaves the file", async () => {
  const path = await tmpPath();
  const a = new PidLock(path, { pid: 111 });
  await a.acquire();
  await a.acquire();
  new PidLock(path, { pid: 222 }).release();
  expect(existsSync(path)).toBe(true);
  await writeFile(path, "111");
  await new PidLock(path, { pid: 111 }).acquire(); // same pid in a new instance counts as ours
});
