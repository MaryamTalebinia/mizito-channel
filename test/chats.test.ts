import { expect, test } from "bun:test";
import { AmbiguousChat, ChatNotFound } from "../src/core/errors";
import { ChatService, normalizeName } from "../src/core/chats";
import type { Poster } from "../src/core/client";

interface Extra { users?: unknown[]; uid?: string; usersFail?: boolean }
function fakePoster(dialogs: unknown[], history: Record<string, unknown[]>, extra: Extra = {}) {
  const calls: { path: string; body: any }[] = [];
  const poster: Poster = {
    async post(path, body) {
      calls.push({ path, body });
      if (path === "/api/chat/getDialogs") return { dialogs };
      if (path === "/api/chat/getHistory") {
        const all = history[(body as any).dialog] ?? [];
        return all.slice((body as any).offset, (body as any).offset + 15);
      }
      if (path === "/api/workspace/getUsers") {
        if (extra.usersFail) throw new Error("users failed");
        return { users: extra.users ?? [] };
      }
      if (path === "/api/workspace/userId") return { uid: extra.uid ?? "" };
      throw new Error(`unexpected ${path}`);
    },
  };
  return { poster, calls };
}

const dialogs = [
  { _id: "d1", is_group: false, title: "دستيار ميزيتو" },
  { _id: "d2", is_group: true, title: "تیم فنی بازرگ" },
  { _id: "d3", is_group: true, title: "Ata Team" },
  { _id: "d4", is_group: true, title: "Ata Sales" },
];

const mk = (i: number, text: string) => ({ _id: `m${i}`, from: "u2", date: 1000 + i, message: text, msg_index: i });
const newestFirst = (n: number, text = (i: number) => `msg ${i}`) =>
  Array.from({ length: n }, (_, k) => mk(n - 1 - k, text(n - 1 - k)));

test("normalizeName unifies Arabic/Persian letters, ZWNJ, digits and case", () => {
  expect(normalizeName("دستيار ميزيتو")).toBe(normalizeName("دستیار میزیتو"));
  expect(normalizeName("كار")).toBe(normalizeName("کار"));
  expect(normalizeName("تیم‌فنی")).toBe(normalizeName("تیم فنی"));
  expect(normalizeName("گروه ۱۲۳")).toBe(normalizeName("گروه 123"));
  expect(normalizeName("گروه ١٢٣")).toBe(normalizeName("گروه 123"));
  expect(normalizeName("  ATA   Team ")).toBe("ata team");
});

test("listChats returns normalized chats", async () => {
  const svc = new ChatService(fakePoster(dialogs, {}).poster);
  expect((await svc.listChats()).map((c) => c.id)).toEqual(["d1", "d2", "d3", "d4"]);
});

test("resolveChat: id, then exact name, then unique substring", async () => {
  const svc = new ChatService(fakePoster(dialogs, {}).poster);
  expect((await svc.resolveChat("d2")).id).toBe("d2");
  expect((await svc.resolveChat("Ata Team")).id).toBe("d3");
  expect((await svc.resolveChat("فنی")).id).toBe("d2");
});

test("resolveChat matches Persian names typed with Arabic letters", async () => {
  const svc = new ChatService(fakePoster(dialogs, {}).poster);
  expect((await svc.resolveChat("دستیار میزیتو")).id).toBe("d1");
  expect((await svc.resolveChat("دستيار")).id).toBe("d1");
});

test("resolveChat throws AmbiguousChat with candidates, and ChatNotFound", async () => {
  const svc = new ChatService(fakePoster(dialogs, {}).poster);
  const err = await svc.resolveChat("ata").catch((e) => e);
  expect(err).toBeInstanceOf(AmbiguousChat);
  expect(err.candidates).toEqual(["Ata Team", "Ata Sales"]);
  await expect(svc.resolveChat("nothing-like-this")).rejects.toBeInstanceOf(ChatNotFound);
});

test("readMessages pages until the limit, newest first", async () => {
  const f = fakePoster(dialogs, { d3: newestFirst(40) });
  const msgs = await new ChatService(f.poster).readMessages("d3", { limit: 20 });
  expect(msgs).toHaveLength(20);
  expect(msgs[0]!.index).toBe(39);
  expect(msgs[19]!.index).toBe(20);
  expect(f.calls.filter((c) => c.path.endsWith("getHistory")).map((c) => c.body.offset)).toEqual([0, 15]);
});

test("readMessages honours offset and stops on an empty chat", async () => {
  const f = fakePoster(dialogs, { d3: newestFirst(5) });
  const svc = new ChatService(f.poster);
  expect(await svc.readMessages("d4", { limit: 10 })).toEqual([]);
  expect((await svc.readMessages("d3", { limit: 10, offset: 2 })).map((m) => m.index)).toEqual([2, 1, 0]);
});

test("search scans history for a normalized substring", async () => {
  const f = fakePoster(dialogs, { d3: newestFirst(30, (i) => (i === 3 ? "قرارداد جدید ي" : `msg ${i}`)) });
  const hits = await new ChatService(f.poster).search("d3", "قرارداد جدید ی");
  expect(hits.map((m) => m.index)).toEqual([3]);
});

test("search respects maxPages", async () => {
  const f = fakePoster(dialogs, { d3: newestFirst(60, (i) => (i === 0 ? "needle" : "hay")) });
  const svc = new ChatService(f.poster);
  expect(await svc.search("d3", "needle", 2)).toEqual([]);
  expect((await svc.search("d3", "needle", 10)).map((m) => m.index)).toEqual([0]);
});

test("messages know which are mine when userId is configured", async () => {
  const f = fakePoster(dialogs, { d3: [{ ...mk(1, "x"), from: "me-id" }] });
  const [m] = await new ChatService(f.poster, { userId: "me-id" }).readMessages("d3", { limit: 1 });
  expect(m!.fromMe).toBe(true);
});

test("resolveChat with exact:true refuses partial names but accepts ids and exact names", async () => {
  const svc = new ChatService(fakePoster(dialogs, {}).poster);
  expect((await svc.resolveChat("d3", { exact: true })).id).toBe("d3");
  expect((await svc.resolveChat("Ata Team", { exact: true })).id).toBe("d3");
  expect((await svc.resolveChat("دستیار میزیتو", { exact: true })).id).toBe("d1");
  await expect(svc.resolveChat("Team", { exact: true })).rejects.toBeInstanceOf(ChatNotFound);
});

const dmDialogs = [
  { _id: "dm1", is_group: false, peer_user: "peer1" },
  { _id: "dm2", is_group: false, peer_user: "peer2" },
  { _id: "g1", is_group: true, title: "Group One" },
];
const users = [
  { _id: "peer1", first_name: "علی", last_name: "رضا" },
  { _id: "peer2", first_name: "Sara", last_name: "" },
  { _id: "other", first_name: "Else", last_name: "Where" },
];
const usersCalls = (f: ReturnType<typeof fakePoster>) => f.calls.filter((c) => c.path.endsWith("getUsers")).length;

test("DM names come from one workspace users lookup; group titles are untouched", async () => {
  const f = fakePoster(dmDialogs, {}, { users });
  const chats = await new ChatService(f.poster).listChats();
  expect(chats.map((c) => c.name)).toEqual(["علی رضا", "Sara", "Group One"]);
  expect(usersCalls(f)).toBe(1);
});

test("names are cached: a second listChats makes no extra users call", async () => {
  const f = fakePoster(dmDialogs, {}, { users });
  const svc = new ChatService(f.poster);
  await svc.listChats();
  await svc.listChats();
  expect(usersCalls(f)).toBe(1);
});

test("an unknown peer falls back to the id", async () => {
  const f = fakePoster(dmDialogs, {}, { users: [users[0]!] });
  expect((await new ChatService(f.poster).listChats()).map((c) => c.name)).toEqual(["علی رضا", "dm2", "Group One"]);
});

test("a failed users lookup falls back to ids and is retried next time", async () => {
  const f = fakePoster(dmDialogs, {}, { usersFail: true });
  const svc = new ChatService(f.poster);
  expect((await svc.listChats()).map((c) => c.name)).toEqual(["dm1", "dm2", "Group One"]);
  await svc.listChats();
  expect(usersCalls(f)).toBe(2);
});

test("a persistent name cache keyed by peer id is consulted and written", async () => {
  const store = new Map<string, string>([["peer1", "Cached Name"]]);
  const names = { get: (id: string) => store.get(id), set: (id: string, n: string) => void store.set(id, n), save: async () => {} };
  const f = fakePoster(dmDialogs, {}, { users });
  const chats = await new ChatService(f.poster, { names }).listChats();
  expect(chats[0]!.name).toBe("Cached Name");
  expect(store.get("peer2")).toBe("Sara");
  expect(usersCalls(f)).toBe(1);
  await new ChatService(f.poster, { names }).listChats();
  expect(usersCalls(f)).toBe(1); // everything cached now
});

test("my own id comes from workspace userId when not configured", async () => {
  const hist = { g1: [{ ...mk(1, "x"), from: "me-id" }, { ...mk(0, "y"), from: "peer9" }] };
  const f = fakePoster(dmDialogs, hist, { users, uid: "me-id" });
  const msgs = await new ChatService(f.poster).readMessages("g1", { limit: 2 });
  expect(msgs.map((m) => m.fromMe)).toEqual([true, false]);
});

test("a configured userId skips the lookup", async () => {
  const f = fakePoster(dmDialogs, { g1: [{ ...mk(1, "x"), from: "cfg" }] }, { users, uid: "someone-else" });
  const [m] = await new ChatService(f.poster, { userId: "cfg" }).readMessages("g1", { limit: 1 });
  expect(m!.fromMe).toBe(true);
  expect(f.calls.some((c) => c.path.endsWith("userId"))).toBe(false);
});
