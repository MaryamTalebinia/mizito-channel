import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CursorStore } from "../src/core/cursor";
import { Watcher, waitForMessages } from "../src/core/watcher";
import { FakeChats, msg } from "./helpers";

const NOW = 1500;
const old = (i: number) => msg(i, { date: 500 + i });
const fresh = (i: number, over = {}) => msg(i, { date: 2000 + i, ...over });

async function setup() {
  const path = join(await mkdtemp(join(tmpdir(), "mizito-")), "cursors.json");
  const chats = new FakeChats();
  const open = async () => new Watcher({ chats, cursors: await CursorStore.open(path), now: () => NOW });
  return { chats, open, path };
}

test("first poll baselines existing history and emits nothing", async () => {
  const { chats, open } = await setup();
  chats.addChat("c1", [old(0), old(1), old(2)]);
  const w = await open();
  expect(await w.poll()).toEqual([]);
});

test("emits each new message exactly once, in order", async () => {
  const { chats, open } = await setup();
  chats.addChat("c1", [old(0)]);
  const w = await open();
  await w.poll();
  chats.add("c1", fresh(1));
  chats.add("c1", fresh(2));
  expect((await w.poll()).map((m) => m.index)).toEqual([1, 2]);
  expect(await w.poll()).toEqual([]);
});

test("a burst larger than one page is fully delivered in order", async () => {
  const { chats, open } = await setup();
  chats.addChat("c1", [old(0)]);
  const w = await open();
  await w.poll();
  for (let i = 1; i <= 40; i++) chats.add("c1", fresh(i));
  const got = (await w.poll()).map((m) => m.index);
  expect(got).toEqual(Array.from({ length: 40 }, (_, k) => k + 1));
});

test("restart resumes from the saved cursor: nothing lost, nothing duplicated", async () => {
  const { chats, open } = await setup();
  chats.addChat("c1", [old(0)]);
  const w1 = await open();
  await w1.poll();
  chats.add("c1", fresh(1));
  expect((await w1.poll()).map((m) => m.index)).toEqual([1]);
  chats.add("c1", fresh(2)); // arrives while "stopped"
  const w2 = await open();
  expect((await w2.poll()).map((m) => m.index)).toEqual([2]);
  expect(await w2.poll()).toEqual([]);
});

test("edited messages are not re-delivered", async () => {
  const { chats, open } = await setup();
  chats.addChat("c1", [old(0)]);
  const w = await open();
  await w.poll();
  chats.add("c1", fresh(1));
  await w.poll();
  chats.edit("c1", 1, "edited text");
  expect(await w.poll()).toEqual([]);
});

test("deleted messages are skipped but the cursor still advances", async () => {
  const { chats, open } = await setup();
  chats.addChat("c1", [old(0)]);
  const w = await open();
  await w.poll();
  chats.add("c1", fresh(1, { deleted: true, text: "" }));
  expect(await w.poll()).toEqual([]);
  chats.add("c1", fresh(2));
  expect((await w.poll()).map((m) => m.index)).toEqual([2]);
});

test("an empty chat at start does not crash and delivers its first message", async () => {
  const { chats, open } = await setup();
  chats.addChat("c1", []);
  const w = await open();
  expect(await w.poll()).toEqual([]);
  chats.add("c1", fresh(0));
  expect((await w.poll()).map((m) => m.index)).toEqual([0]);
});

test("a chat that appears after start delivers only messages from after start", async () => {
  const { chats, open } = await setup();
  chats.addChat("c1", [old(0)]);
  const w = await open();
  await w.poll();
  chats.addChat("c2", [old(0), old(1), fresh(2), fresh(3)]);
  expect((await w.poll()).map((m) => `${m.chatId}:${m.index}`)).toEqual(["c2:2", "c2:3"]);
});

test("a failing chat is retried next poll while others still deliver", async () => {
  const { chats, open } = await setup();
  chats.addChat("c1", [old(0)]);
  chats.addChat("c2", [old(0)]);
  const w = await open();
  await w.poll();
  chats.add("c1", fresh(1));
  chats.add("c2", fresh(1));
  chats.failFor.add("c1");
  expect((await w.poll()).map((m) => m.chatId)).toEqual(["c2"]);
  chats.failFor.clear();
  expect((await w.poll()).map((m) => m.chatId)).toEqual(["c1"]);
});

test("if every chat fails the error is thrown", async () => {
  const { chats, open } = await setup();
  chats.addChat("c1", [old(0)]);
  const w = await open();
  await w.poll();
  chats.add("c1", fresh(1));
  chats.failFor.add("c1");
  await expect(w.poll()).rejects.toThrow(/history failed/);
});

test("concurrent polls are serialized: no duplicates", async () => {
  const { chats, open } = await setup();
  chats.addChat("c1", [old(0)]);
  const w = await open();
  await w.poll();
  chats.add("c1", fresh(1));
  const [a, b] = await Promise.all([w.poll(), w.poll()]);
  expect(a.length + b.length).toBe(1);
});

test("waitForMessages returns as soon as there is something", async () => {
  let calls = 0;
  const w = { poll: async () => (++calls === 3 ? [msg(1)] : []) };
  let t = 0;
  const got = await waitForMessages(w, {
    timeoutMs: 10_000, intervalMs: 100, now: () => t, sleep: async (ms) => { t += ms; },
  });
  expect(got).toHaveLength(1);
  expect(calls).toBe(3);
});

test("waitForMessages gives up with [] at the timeout", async () => {
  let t = 0;
  const got = await waitForMessages({ poll: async () => [] }, {
    timeoutMs: 1000, intervalMs: 400, now: () => t, sleep: async (ms) => { t += ms; },
  });
  expect(got).toEqual([]);
  expect(t).toBeLessThanOrEqual(1000);
});
