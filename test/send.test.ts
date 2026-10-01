import { expect, test } from "bun:test";
import { ConfigError, SendDisabled } from "../src/core/errors";
import type { Poster } from "../src/core/client";
import { sendMessage } from "../src/core/send";

function recorder() {
  const calls: { path: string; body: any }[] = [];
  const poster: Poster = { async post(path, body) { calls.push({ path, body }); return {}; } };
  return { poster, calls };
}

const deterministic = { now: () => 1234, randomHex: (n: number) => "ab".repeat(n) };

test("refuses when sending is disabled and makes no request", async () => {
  const r = recorder();
  await expect(sendMessage(r.poster, "d1", "hi", { allowSend: false, userId: "u1" })).rejects.toBeInstanceOf(SendDisabled);
  expect(r.calls).toHaveLength(0);
});

test("refuses without a user id (needed for the from field)", async () => {
  const r = recorder();
  await expect(sendMessage(r.poster, "d1", "hi", { allowSend: true })).rejects.toBeInstanceOf(ConfigError);
  expect(r.calls).toHaveLength(0);
});

test("posts the web client's message shape", async () => {
  const r = recorder();
  await sendMessage(r.poster, "d1", "hello", { allowSend: true, userId: "u1", ...deterministic });
  expect(r.calls).toEqual([
    {
      path: "/api/chat/send",
      body: {
        _: "message", _id: "ab".repeat(12), dialog: "d1", message: "hello", from: "u1",
        date: 1234, reply_to: null, mention: [], randomId: "ab".repeat(8),
      },
    },
  ]);
});

test("preserves plain text and newlines without HTML formatting", async () => {
  const r = recorder();
  await sendMessage(r.poster, "d1", "a <b> & c\nd", { allowSend: true, userId: "u1", ...deterministic });
  expect(r.calls[0]!.body.message).toBe("a <b> & c\nd");
});

test("rejects empty text", async () => {
  const r = recorder();
  await expect(sendMessage(r.poster, "d1", "   ", { allowSend: true, userId: "u1" })).rejects.toThrow(/empty/i);
  expect(r.calls).toHaveLength(0);
});
