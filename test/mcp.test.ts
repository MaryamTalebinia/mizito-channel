import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, startPush, type McpDeps } from "../src/mcp/server";
import { AmbiguousChat, RateLimited } from "../src/core/errors";
import type { Chat } from "../src/core/models";
import { msg } from "./helpers";

const chat: Chat = { id: "c1", name: "Ata", isGroup: false, unread: 1, messagesCount: 3 };

function deps(over: Partial<McpDeps> = {}): McpDeps & { sent: [string, string][] } {
  const sent: [string, string][] = [];
  return {
    chats: {
      listChats: async () => [chat],
      resolveChat: async () => chat,
      readMessages: async () => [msg(2, { text: "two" }), msg(1, { text: "one" })],
      search: async () => [msg(1, { text: "one" })],
    },
    watcher: { poll: async () => [msg(9, { text: "fresh" })] },
    send: async (id, text) => { sent.push([id, text]); },
    allowSend: false,
    push: false,
    pollIntervalMs: 1,
    sent,
    ...over,
  };
}

async function connect(d: McpDeps) {
  const server = createMcpServer(d);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { server, client };
}

const textOf = (r: any) => r.content[0].text as string;

test("registers read tools and hides send by default", async () => {
  const { client } = await connect(deps());
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(names).toEqual(["list_chats", "read_messages", "search_chat", "wait_for_messages"]);
});

test("send_message appears only when allowed, annotated as destructive", async () => {
  const { client } = await connect(deps({ allowSend: true }));
  const send = (await client.listTools()).tools.find((t) => t.name === "send_message");
  expect(send).toBeDefined();
  expect(send!.annotations?.destructiveHint).toBe(true);
  expect(send!.annotations?.readOnlyHint).toBe(false);
});

test("read tools are annotated read-only", async () => {
  const { client } = await connect(deps());
  const tools = (await client.listTools()).tools;
  for (const n of ["list_chats", "read_messages", "search_chat", "wait_for_messages"]) {
    expect(tools.find((t) => t.name === n)!.annotations?.readOnlyHint).toBe(true);
  }
});

test("list_chats returns JSON", async () => {
  const { client } = await connect(deps());
  const r = await client.callTool({ name: "list_chats", arguments: {} });
  expect(JSON.parse(textOf(r))[0].id).toBe("c1");
});

test("read_messages returns messages and passes the limit", async () => {
  let seen: unknown;
  const d = deps();
  d.chats.readMessages = async (_c: string, o: any) => { seen = o; return [msg(1, { text: "one" })]; };
  const { client } = await connect(d);
  const r = await client.callTool({ name: "read_messages", arguments: { chat: "Ata", limit: 5 } });
  expect(JSON.parse(textOf(r))[0].text).toBe("one");
  expect(seen).toEqual({ limit: 5 });
});

test("search_chat returns matches", async () => {
  const { client } = await connect(deps());
  const r = await client.callTool({ name: "search_chat", arguments: { chat: "Ata", query: "one" } });
  expect(JSON.parse(textOf(r))).toHaveLength(1);
});

test("wait_for_messages returns new messages", async () => {
  const { client } = await connect(deps());
  const r = await client.callTool({ name: "wait_for_messages", arguments: { timeout_seconds: 1 } });
  expect(JSON.parse(textOf(r))[0].text).toBe("fresh");
});

test("wait_for_messages returns an empty list on timeout", async () => {
  const { client } = await connect(deps({ watcher: { poll: async () => [] } }));
  const r = await client.callTool({ name: "wait_for_messages", arguments: { timeout_seconds: 1 } });
  expect(JSON.parse(textOf(r))).toEqual([]);
});

test("domain errors become isError results with the message", async () => {
  const d = deps();
  d.chats.readMessages = async () => { throw new AmbiguousChat("a", ["A1", "A2"]); };
  const { client } = await connect(d);
  const r: any = await client.callTool({ name: "read_messages", arguments: { chat: "a" } });
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain("A1");
});

test("send_message sends when allowed", async () => {
  const d = deps({ allowSend: true });
  const { client } = await connect(d);
  const r: any = await client.callTool({ name: "send_message", arguments: { chat: "Ata", text: "hi" } });
  expect(r.isError).toBeFalsy();
  expect(d.sent).toEqual([["c1", "hi"]]);
});

test("push mode drops wait_for_messages and pushes channel notifications", async () => {
  const d = deps({ push: true });
  const { server, client } = await connect(d);
  expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("wait_for_messages");

  const got: any[] = [];
  client.fallbackNotificationHandler = async (n) => { got.push(n); };
  const ac = new AbortController();
  let polls = 0;
  d.watcher.poll = async () => (++polls === 1 ? [msg(5, { text: "pushed", chatName: "Ata" })] : (ac.abort(), []));
  await startPush(server, d, ac.signal);
  await new Promise((r) => setTimeout(r, 10));
  expect(got).toHaveLength(1);
  expect(got[0].params.content).toBe("pushed");
  expect(got[0].params.meta.chat_name).toBe("Ata");
});

test("send_message resolves the chat with exact matching only", async () => {
  let seen: unknown;
  const d = deps({ allowSend: true });
  d.chats.resolveChat = async (_ref: string, o?: unknown) => { seen = o; return chat; };
  const { client } = await connect(d);
  await client.callTool({ name: "send_message", arguments: { chat: "At", text: "hi" } });
  expect(seen).toEqual({ exact: true });
});

test("push content falls back to an attachment description when there is no text", async () => {
  const d = deps({ push: true });
  const { server, client } = await connect(d);
  const got: any[] = [];
  client.fallbackNotificationHandler = async (n) => { got.push(n); };
  const ac = new AbortController();
  let polls = 0;
  d.watcher.poll = async () =>
    ++polls === 1 ? [msg(6, { text: "", attachment: { kind: "photo", name: "a.jpg" } })] : (ac.abort(), []);
  await startPush(server, d, ac.signal);
  await new Promise((r) => setTimeout(r, 10));
  expect(got[0].params.content).toBe("[photo: a.jpg]");
});

test("push only forwards allowlisted chats and never my own messages", async () => {
  const d = deps({ push: true, pushChatIds: new Set(["c1"]) });
  const { server, client } = await connect(d);
  const got: any[] = [];
  client.fallbackNotificationHandler = async (n) => { got.push(n); };
  const ac = new AbortController();
  let polls = 0;
  d.watcher.poll = async () =>
    ++polls === 1
      ? [
          msg(1, { chatId: "c1", text: "keep" }),
          msg(2, { chatId: "c2", text: "other chat" }),
          msg(3, { chatId: "c1", text: "mine", fromMe: true }),
        ]
      : (ac.abort(), []);
  await startPush(server, d, ac.signal);
  await new Promise((r) => setTimeout(r, 10));
  expect(got.map((n) => n.params.content)).toEqual(["keep"]);
});

test("wait_for_messages uses the leased poll when the watcher offers one", async () => {
  let leased = 0;
  const d = deps({ watcher: { poll: async () => [], pollLeased: async () => { leased++; return [msg(7, { text: "leased" })]; } } });
  const { client } = await connect(d);
  const r = await client.callTool({ name: "wait_for_messages", arguments: { timeout_seconds: 1 } });
  expect(JSON.parse(textOf(r))[0].text).toBe("leased");
  expect(leased).toBe(1);
});

test("push commits the batch only after every notification was delivered", async () => {
  const d = deps({ push: true });
  const { server } = await connect(d);
  const ac = new AbortController();
  let commits = 0;
  let polls = 0;
  d.watcher.pollBatch = async () =>
    ++polls === 1 ? { messages: [msg(1, { text: "a" })], commit: async () => { commits++; } } : (ac.abort(), { messages: [], commit: async () => {} });
  await startPush(server, d, ac.signal);
  await new Promise((r) => setTimeout(r, 30));
  ac.abort();
  expect(commits).toBe(1);
});

test("push does not commit when a notification fails, so the batch is retried", async () => {
  const d = deps({ push: true });
  const { server } = await connect(d);
  (server.server as any).notification = async () => { throw new Error("transport closed"); };
  const ac = new AbortController();
  let commits = 0;
  let polls = 0;
  d.watcher.pollBatch = async () =>
    ++polls <= 2 ? { messages: [msg(1, { text: "a" })], commit: async () => { commits++; } } : (ac.abort(), { messages: [], commit: async () => {} });
  const orig = console.error;
  console.error = () => {};
  await startPush(server, d, ac.signal);
  await new Promise((r) => setTimeout(r, 30));
  console.error = orig;
  ac.abort();
  expect(commits).toBe(0);
  expect(polls).toBeGreaterThanOrEqual(2); // retried
});

test("push backs off while idle and after errors, using the injected sleep", async () => {
  const delays: number[] = [];
  const ac = new AbortController();
  let polls = 0;
  const d = deps({
    push: true,
    pollIntervalMs: 1000,
    sleep: async (ms: number) => { delays.push(ms); },
    watcher: {
      poll: async () => {
        polls++;
        if (polls === 1) return [];
        if (polls === 2) throw new RateLimited();
        if (polls === 3) return [msg(1, { text: "x" })];
        ac.abort();
        return [];
      },
    },
  });
  const { server } = await connect(d);
  const orig = console.error;
  console.error = () => {};
  await startPush(server, d, ac.signal);
  await new Promise((r) => setTimeout(r, 30));
  console.error = orig;
  expect(delays).toEqual([1500, 3000, 1000]);
});
