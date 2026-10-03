import { expect, test } from "bun:test";
import { runCli, type CliDeps } from "../src/cli/run";
import { AuthError, NetworkError, RateLimited, SendDisabled } from "../src/core/errors";
import type { Chat } from "../src/core/models";
import { msg } from "./helpers";

const chat: Chat = { id: "c1", name: "Ata", isGroup: false, unread: 2, messagesCount: 5 };

function harness(over: Partial<CliDeps> = {}, signal?: AbortSignal) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: [string, string][] = [];
  const filesSent: [string, string[], string | undefined][] = [];
  const deps: CliDeps = {
    chats: {
      listChats: async () => [chat],
      resolveChat: async () => chat,
      readMessages: async () => [msg(2, { text: "second" }), msg(1, { text: "first" })],
      search: async () => [msg(1, { text: "first" })],
    },
    watcher: () => ({ poll: async () => [] }),
    send: async (id, text) => { sent.push([id, text]); },
    sendFiles: async (id, paths, text) => { filesSent.push([id, paths, text]); },
    login: async () => { out.push("logged-in"); },
    startMcp: async () => { out.push("mcp-started"); },
    pollIntervalMs: 1,
    sleep: async () => {},
    ...over,
  };
  const run = (argv: string[]) => runCli(argv, deps, { out: (s) => out.push(s), err: (s) => err.push(s), signal });
  return { run, out, err, sent, filesSent };
}

test("chats prints a table row per chat", async () => {
  const h = harness();
  expect(await h.run(["chats"])).toBe(0);
  expect(h.out.join("\n")).toContain("c1");
  expect(h.out.join("\n")).toContain("Ata");
});

test("chats --json prints parseable JSON", async () => {
  const h = harness();
  await h.run(["chats", "--json"]);
  expect(JSON.parse(h.out.join(""))[0].id).toBe("c1");
});

test("read prints oldest first in text mode and newest first in json mode", async () => {
  const h = harness();
  await h.run(["read", "Ata"]);
  const text = h.out.join("\n");
  expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
  const j = harness();
  await j.run(["read", "Ata", "--json"]);
  expect(JSON.parse(j.out.join("")).map((m: any) => m.text)).toEqual(["second", "first"]);
});

test("read passes --limit through", async () => {
  let seen: unknown;
  const h = harness({
    chats: {
      listChats: async () => [chat],
      resolveChat: async () => chat,
      search: async () => [],
      readMessages: async (_ref, o) => { seen = o; return []; },
    },
  });
  await h.run(["read", "Ata", "--limit", "7"]);
  expect(seen).toEqual({ limit: 7 });
});

test("search prints matches", async () => {
  const h = harness();
  expect(await h.run(["search", "Ata", "first"])).toBe(0);
  expect(h.out.join("\n")).toContain("first");
});

test("send resolves the chat then sends", async () => {
  const h = harness();
  expect(await h.run(["send", "Ata", "hello there"])).toBe(0);
  expect(h.sent).toEqual([["c1", "hello there"]]);
});

test("send maps SendDisabled to exit code 3 with a message on stderr", async () => {
  const h = harness({ send: async () => { throw new SendDisabled(); } });
  expect(await h.run(["send", "Ata", "hi"])).toBe(3);
  expect(h.err.join("")).toContain("MIZITO_ALLOW_SEND=1");
});

test("send-files resolves exactly and sends paths with an optional --text caption", async () => {
  let seen: unknown;
  const h = harness({
    chats: {
      listChats: async () => [chat],
      resolveChat: async (_ref: string, o?: unknown) => { seen = o; return chat; },
      readMessages: async () => [], search: async () => [],
    },
  });
  expect(await h.run(["send-files", "Ata", "/tmp/a.pdf", "/tmp/b.pptx", "--text", "caption here"])).toBe(0);
  expect(seen).toEqual({ exact: true });
  expect(h.filesSent).toEqual([["c1", ["/tmp/a.pdf", "/tmp/b.pptx"], "caption here"]]);
});

test("auth errors exit 2", async () => {
  const h = harness({ chats: { listChats: async () => { throw new AuthError("nope"); }, resolveChat: async () => chat, readMessages: async () => [], search: async () => [] } });
  expect(await h.run(["chats"])).toBe(2);
});

test("unknown errors exit 1 and usage errors exit 64", async () => {
  const h = harness({ chats: { listChats: async () => { throw new Error("boom"); }, resolveChat: async () => chat, readMessages: async () => [], search: async () => [] } });
  expect(await h.run(["chats"])).toBe(1);
  const u = harness();
  expect(await u.run(["frobnicate"])).toBe(64);
  expect(await u.run(["read"])).toBe(64);
  expect(await u.run([])).toBe(64);
});

test("login and mcp delegate", async () => {
  const h = harness();
  await h.run(["login"]);
  await h.run(["mcp"]);
  expect(h.out).toEqual(["logged-in", "mcp-started"]);
});

test("hermes-watch requires both webhook settings", async () => {
  const h = harness();
  expect(await h.run(["hermes-watch"])).toBe(1);
  expect(h.err.join("\n")).toContain("HERMES_WEBHOOK_URL");
  expect(h.err.join("\n")).toContain("HERMES_WEBHOOK_SECRET");
});

test("hermes-watch posts and commits a batch", async () => {
  const ac = new AbortController();
  let committed = 0;
  let posted = 0;
  const h = harness({
    hermesWebhookUrl: "https://hermes.example/hook",
    hermesWebhookSecret: "secret",
    hermesFetch: async () => { posted++; return new Response(null, { status: 204 }); },
    watcher: () => ({
      poll: async () => [],
      pollBatch: async () => ({
        messages: [msg(1)],
        commit: async () => { committed++; ac.abort(); },
      }),
    }),
  }, ac.signal);
  expect(await h.run(["hermes-watch"])).toBe(0);
  expect(posted).toBe(1);
  expect(committed).toBe(1);
});

test("watch --json streams one JSON line per message until aborted", async () => {
  const ac = new AbortController();
  let n = 0;
  const h = harness(
    { watcher: () => ({ poll: async () => (++n === 1 ? [msg(1, { text: "ping" })] : (ac.abort(), [])) }) },
    ac.signal,
  );
  expect(await h.run(["watch", "--json"])).toBe(0);
  const lines = h.out.filter((l) => l.trim().startsWith("{"));
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!).text).toBe("ping");
});

test("send resolves the chat with exact matching only", async () => {
  let seen: unknown;
  const h = harness({
    chats: {
      listChats: async () => [chat],
      resolveChat: async (_ref: string, o?: unknown) => { seen = o; return chat; },
      readMessages: async () => [],
      search: async () => [],
    },
  });
  await h.run(["send", "At", "hi"]);
  expect(seen).toEqual({ exact: true });
});

test("read shows attachment-only messages as a bracketed description", async () => {
  const h = harness({
    chats: {
      listChats: async () => [chat],
      resolveChat: async () => chat,
      readMessages: async () => [msg(1, { text: "", attachment: { kind: "photo", name: "a.jpg" } })],
      search: async () => [],
    },
  });
  await h.run(["read", "Ata"]);
  expect(h.out.join("\n")).toContain("[photo: a.jpg]");
});

test("--limit must be a positive whole number", async () => {
  const h = harness();
  expect(await h.run(["read", "Ata", "--limit", "abc"])).toBe(64);
  expect(await h.run(["read", "Ata", "--limit", "0"])).toBe(64);
  expect(await h.run(["read", "Ata", "--limit", "2.5"])).toBe(64);
  expect(await h.run(["read", "Ata", "--limit", "3"])).toBe(0);
});

test("watch commits each batch only after printing it", async () => {
  const ac = new AbortController();
  const order: string[] = [];
  let n = 0;
  const h = harness(
    {
      watcher: () => ({
        poll: async () => [],
        pollBatch: async () => {
          if (++n === 1) return { messages: [msg(1, { text: "ping" })], commit: async () => { order.push("commit"); } };
          ac.abort();
          return { messages: [], commit: async () => {} };
        },
      }),
    },
    ac.signal,
  );
  const out = h.out;
  expect(await h.run(["watch", "--json"])).toBe(0);
  expect(out.filter((l) => l.startsWith("{"))).toHaveLength(1);
  expect(order).toEqual(["commit"]);
});

test("text output names the sender of each message", async () => {
  const h = harness({
    chats: {
      listChats: async () => [chat],
      resolveChat: async () => chat,
      readMessages: async () => [msg(2, { sender: "Sara", text: "hi" }), msg(1, { sender: "me", text: "yo" })],
      search: async () => [],
    },
  });
  await h.run(["read", "Ata"]);
  const out = h.out.join("\n");
  expect(out).toContain("Sara: hi");
  expect(out).toContain("me: yo");
});

test("watch backs off while idle and resets after a message", async () => {
  const ac = new AbortController();
  const delays: number[] = [];
  const script = [[], [], [msg(1, { text: "hi" })], [], "stop"] as const;
  let i = 0;
  const h = harness(
    {
      pollIntervalMs: 1000,
      sleep: async (ms) => { delays.push(ms); },
      watcher: () => ({
        poll: async () => {
          const step = script[i++]!;
          if (step === "stop") { ac.abort(); return []; }
          return [...step];
        },
      }),
    },
    ac.signal,
  );
  expect(await h.run(["watch"])).toBe(0);
  expect(delays).toEqual([1500, 2250, 1000, 1500]);
});

test("watch survives rate limiting and network errors by backing off, but exits on auth errors", async () => {
  const ac = new AbortController();
  const delays: number[] = [];
  let i = 0;
  const h = harness(
    {
      pollIntervalMs: 1000,
      sleep: async (ms) => { delays.push(ms); },
      watcher: () => ({
        poll: async () => {
          i++;
          if (i === 1) throw new RateLimited();
          if (i === 2) throw new NetworkError("down");
          ac.abort();
          return [];
        },
      }),
    },
    ac.signal,
  );
  expect(await h.run(["watch"])).toBe(0);
  expect(delays).toEqual([2000, 4000]);
  expect(h.err.join("\n")).toContain("rate-limited");

  const bad = harness({ watcher: () => ({ poll: async () => { throw new AuthError("session dead"); } }) });
  expect(await bad.run(["watch"])).toBe(2);
});
