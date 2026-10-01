import { expect, test } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CursorStore } from "../src/core/cursor";

const tmpFile = async () => join(await mkdtemp(join(tmpdir(), "mizito-")), "cursors.json");

test("starts empty when the file does not exist", async () => {
  const s = await CursorStore.open(await tmpFile());
  expect(s.get("d1")).toBeUndefined();
});

test("persists across open() calls", async () => {
  const path = await tmpFile();
  const a = await CursorStore.open(path);
  a.set("d1", { index: 9, count: 10, lastDate: 123 });
  await a.save();
  const b = await CursorStore.open(path);
  expect(b.get("d1")).toEqual({ index: 9, count: 10, lastDate: 123 });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("unsaved changes are not persisted", async () => {
  const path = await tmpFile();
  const a = await CursorStore.open(path);
  a.set("d1", { index: 1, count: 1, lastDate: 1 });
  expect((await CursorStore.open(path)).get("d1")).toBeUndefined();
});

test("a corrupt state file starts empty instead of throwing", async () => {
  const path = await tmpFile();
  await Bun.write(path, "garbage");
  expect((await CursorStore.open(path)).get("d1")).toBeUndefined();
});
