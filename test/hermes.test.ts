import { createHmac } from "node:crypto";
import { expect, test } from "bun:test";
import {
  createHermesDelivery,
  postHermesDelivery,
  runHermesWatch,
  type HermesWatchOptions,
} from "../src/core/hermes";
import { msg } from "./helpers";

const baseOptions = (over: Partial<HermesWatchOptions> = {}): HermesWatchOptions => ({
  url: "https://hermes.example/hooks/mizito",
  secret: "top-secret",
  pollIntervalMs: 1000,
  sleep: async () => {},
  ...over,
});

test("Hermes payload, stable delivery id, and exact-body signature", async () => {
  const messages = [
    msg(2, { text: "second", attachment: { kind: "document", name: "safe.pdf", size: 12 } }),
    msg(1, { text: "first", replyTo: "m0", mentions: ["u3"] }),
  ];
  const delivery = createHermesDelivery(messages, () => 1_790_862_222_116);
  expect(delivery.payload).toEqual({
    event_type: "mizito_messages",
    delivery_id: delivery.deliveryId,
    detected_at: "2026-10-01T13:43:42.116Z",
    messages,
  });
  expect(createHermesDelivery([...messages].reverse(), () => 0).deliveryId).toBe(delivery.deliveryId);

  const calls: Array<{ body: string; headers: Headers }> = [];
  await postHermesDelivery(delivery, baseOptions({
    fetch: async (_url, init) => {
      calls.push({ body: String(init?.body), headers: new Headers(init?.headers) });
      return new Response("ok", { status: 204 });
    },
  }));
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.body).toBe(delivery.body);
  expect(call.headers.get("content-type")).toBe("application/json");
  expect(call.headers.get("x-github-event")).toBe("mizito_messages");
  expect(call.headers.get("x-github-delivery")).toBe(delivery.deliveryId);
  expect(call.headers.get("x-hub-signature-256")).toBe(
    `sha256=${createHmac("sha256", "top-secret").update(call.body).digest("hex")}`,
  );
});

test("baseline and outgoing-only batches commit without webhook calls", async () => {
  const ac = new AbortController();
  let commits = 0;
  let polls = 0;
  let requests = 0;
  await runHermesWatch(
    {
      poll: async () => [],
      pollBatch: async () => {
        polls++;
        if (polls === 1) return { messages: [], commit: async () => { commits++; } };
        ac.abort();
        return { messages: [msg(1, { fromMe: true, sender: "me" })], commit: async () => { commits++; } };
      },
    },
    baseOptions({ signal: ac.signal, fetch: async () => { requests++; return new Response(null, { status: 204 }); } }),
  );
  expect(requests).toBe(0);
  expect(commits).toBe(2);
});

test("successful webhook commits only after delivery and excludes outgoing messages", async () => {
  const ac = new AbortController();
  const order: string[] = [];
  let polls = 0;
  let sentBody = "";
  await runHermesWatch(
    {
      poll: async () => [],
      pollBatch: async () => {
        if (++polls === 1) {
          return {
            messages: [msg(1), msg(2, { fromMe: true, sender: "me" })],
            commit: async () => { order.push("commit"); ac.abort(); },
          };
        }
        return { messages: [], commit: async () => {} };
      },
    },
    baseOptions({
      signal: ac.signal,
      fetch: async (_url, init) => { order.push("post"); sentBody = String(init?.body); return new Response(null, { status: 204 }); },
    }),
  );
  expect(order).toEqual(["post", "commit"]);
  expect(JSON.parse(sentBody).messages.map((m: { id: string }) => m.id)).toEqual(["m1"]);
});

test("network, 429, and 5xx failures retry with bounded exponential delays", async () => {
  const delays: number[] = [];
  let attempt = 0;
  const delivery = createHermesDelivery([msg(3)], () => 0);
  await postHermesDelivery(delivery, baseOptions({
    maxAttempts: 4,
    retryBaseMs: 1000,
    retryMaxMs: 2500,
    sleep: async (ms: number) => { delays.push(ms); },
    fetch: async () => {
      attempt++;
      if (attempt === 1) throw new TypeError("offline");
      if (attempt === 2) return new Response(null, { status: 429 });
      if (attempt === 3) return new Response(null, { status: 502 });
      return new Response(null, { status: 204 });
    },
  }));
  expect(delays).toEqual([1000, 2000, 2500]);
});

test("retryable webhook failure never commits and the same delivery is redelivered", async () => {
  let commits = 0;
  let requests = 0;
  const batch = { messages: [msg(7)], commit: async () => { commits++; } };
  const watcher = { poll: async () => [], pollBatch: async () => batch };
  const options = baseOptions({
    maxAttempts: 2,
    fetch: async () => { requests++; return new Response("down", { status: 503 }); },
  });
  await expect(runHermesWatch(watcher, options)).rejects.toThrow("after 2 attempts");
  await expect(runHermesWatch(watcher, options)).rejects.toThrow("after 2 attempts");
  expect(requests).toBe(4);
  expect(commits).toBe(0);
});

test("permanent webhook 4xx fails immediately without committing", async () => {
  let commits = 0;
  let requests = 0;
  await expect(runHermesWatch(
    { poll: async () => [], pollBatch: async () => ({ messages: [msg(1)], commit: async () => { commits++; } }) },
    baseOptions({ maxAttempts: 5, fetch: async () => { requests++; return new Response("bad", { status: 400 }); } }),
  )).rejects.toThrow("permanent HTTP 400");
  expect(requests).toBe(1);
  expect(commits).toBe(0);
});

test("abort during retry stops gracefully without committing", async () => {
  const ac = new AbortController();
  let commits = 0;
  await expect(runHermesWatch(
    { poll: async () => [], pollBatch: async () => ({ messages: [msg(1)], commit: async () => { commits++; } }) },
    baseOptions({
      signal: ac.signal,
      fetch: async () => { ac.abort(); throw new TypeError("network down"); },
    }),
  )).resolves.toBeUndefined();
  expect(commits).toBe(0);
});
