import { expect, test } from "bun:test";
import type { Chat } from "../src/core/models";
import { ChatService } from "../src/core/chats";
import { MizitoClient, type ClientOptions } from "../src/core/client";
import { fetchImageMedia, fetchVoiceMedia } from "../src/core/download";
import { MAX_AUDIO_BYTES, MAX_IMAGE_BYTES } from "../src/core/limits";
import { UnsupportedAudio } from "../src/core/errors";

const id = "0123456789abcdef01234567";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4ZkAAAAASUVORK5CYII=", "base64");
const audio = Buffer.from("synthetic-audio");
const credentials = { username: "synthetic", password: "not-a-credential" };
const dialogs = { dialogs: [{ _id: "chat", title: "Team", is_group: true }] };
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const pause = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function voice(isVoice = true) {
  return [{ _id: id, _: "message", media: { _: "messageMediaAudio", audio: { is_voice: isVoice, content: "audio", duration: 2, size: audio.length } } }];
}
function photo() {
  return [{ _id: id, _: "message", media: { _: "messageMediaPhoto", photo: { _id: "photo", name: "ignored", photo_large: { content: "image", w: 1, h: 1, size: png.length } } } }];
}
function hangingBody() {
  let cancelled = false;
  return {
    body: new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }),
    cancelled: () => cancelled,
  };
}
function client(fetcher: (url: string, init?: RequestInit) => Promise<Response>, extra: Partial<ClientOptions> = {}) {
  return new MizitoClient({ credentials, token: "synthetic-session", mediaTimeoutMs: 15,
    ...extra, fetch: (async (url: any, init?: RequestInit) => fetcher(String(url), init)) as typeof fetch });
}

for (const kind of ["image", "voice"] as const) {
  test(`${kind}: deadline starts before hanging resolve and prevents late CDN work`, async () => {
    const pending = deferred<Chat>();
    let discoverySignal: AbortSignal | undefined;
    let downloads = 0;
    const c = client(async () => { downloads++; return new Response(audio); });
    const chats = new ChatService({ post: async () => voice() });
    chats.resolveChat = async (_ref, options) => { discoverySignal = options?.signal; return pending.promise; };
    const result = kind === "image" ? fetchImageMedia(chats, c, "Team", id, true) : fetchVoiceMedia(chats, c, "Team", id, true);
    await expect(result).rejects.toThrow("timed out");
    expect(discoverySignal?.aborted).toBe(true);
    pending.resolve({ id: "chat", name: "Team", isGroup: true, unread: 0, messagesCount: 0 });
    await pause();
    expect(downloads).toBe(0);
  });
}

for (const path of ["getDialogs", "getHistory", "getUsers"] as const) {
  test(`discovery ${path}: real HTTP signal aborts and a late response body is cancelled`, async () => {
    const pending = deferred<Response>();
    const late = hangingBody();
    let signal: AbortSignal | undefined;
    let cdn = 0;
    const c = client(async (url, init) => {
      if (url.endsWith(path)) { signal = init?.signal as AbortSignal; return pending.promise; }
      if (url.endsWith("getDialogs")) return Response.json(path === "getUsers" ? { dialogs: [{ _id: "chat", peer_user: "peer", is_group: false }] } : dialogs);
      if (url.includes("/cdn/")) cdn++;
      return Response.json(voice());
    });
    await expect(fetchVoiceMedia(new ChatService(c), c, "Team", id, true)).rejects.toThrow("timed out");
    expect(signal?.aborted).toBe(true);
    pending.resolve(new Response(late.body));
    await pause();
    expect(late.cancelled()).toBe(true);
    expect(cdn).toBe(0);
  });
}

test("discovery JSON body read is cancelled rather than leaving res.json running", async () => {
  const pending = hangingBody();
  let signal: AbortSignal | undefined;
  const c = client(async (_url, init) => { signal = init?.signal as AbortSignal; return new Response(pending.body); });
  await expect(fetchVoiceMedia(new ChatService(c), c, "Team", id, true)).rejects.toThrow("timed out");
  expect(signal?.aborted).toBe(true);
  expect(pending.cancelled()).toBe(true);
});

test("direct media initial beforeLogin wait is bounded and cannot start login after timeout", async () => {
  const pending = deferred<void>();
  let signal: AbortSignal | undefined;
  let requests = 0, persisted = 0;
  const c = client(async () => { requests++; return Response.json({ status: 1, token: "new" }); }, {
    token: undefined, beforeLogin: (s) => { signal = s; return pending.promise; }, onToken: () => { persisted++; },
  });
  await expect(c.downloadAudio("audio")).rejects.toThrow("timed out");
  expect(signal?.aborted).toBe(true);
  pending.resolve(); await pause();
  expect(requests).toBe(0); expect(persisted).toBe(0);
});

test("whole-flow discovery initial beforeLogin wait is bounded", async () => {
  const pending = deferred<void>();
  let requests = 0;
  const c = client(async () => { requests++; return Response.json(dialogs); }, { token: undefined, beforeLogin: () => pending.promise });
  await expect(fetchImageMedia(new ChatService(c), c, "Team", id, true)).rejects.toThrow("timed out");
  pending.resolve(); await pause(); expect(requests).toBe(0);
});

for (const mode of ["initial", "cdn401", "discovery401"] as const) {
  test(`${mode}: hanging login fetch aborts with no late token persistence or CDN retry`, async () => {
    const pending = deferred<Response>();
    const late = hangingBody();
    let signal: AbortSignal | undefined;
    let persisted = 0, cdn = 0;
    const c = client(async (url, init) => {
      if (url.endsWith("/capi/session/create")) { signal = init?.signal as AbortSignal; return pending.promise; }
      if (url.includes("/cdn/")) cdn++;
      return new Response(null, { status: 401 });
    }, { token: mode === "initial" ? undefined : "old", onToken: () => { persisted++; } });
    const operation = mode === "discovery401" ? fetchVoiceMedia(new ChatService(c), c, "Team", id, true) : c.downloadImage("image");
    await expect(operation).rejects.toThrow("timed out");
    expect(signal?.aborted).toBe(true);
    pending.resolve(new Response(late.body)); await pause();
    expect(late.cancelled()).toBe(true); expect(persisted).toBe(0);
    expect(cdn).toBe(mode === "cdn401" ? 1 : 0);
    // Aborted login did not install a token internally either.
    const ac = new AbortController(); ac.abort();
    await expect(c.post("/api/unused", {}, ac.signal)).rejects.toThrow();
  });
}

test("initial login JSON body is cancelled and cannot persist authentication", async () => {
  const pending = hangingBody();
  let signal: AbortSignal | undefined;
  let persisted = 0, cdn = 0;
  const c = client(async (url, init) => {
    if (url.includes("/cdn/")) cdn++;
    signal = init?.signal as AbortSignal;
    return new Response(pending.body);
  }, { token: undefined, onToken: () => { persisted++; } });
  await expect(c.downloadAudio("audio")).rejects.toThrow("timed out");
  expect(signal?.aborted).toBe(true); expect(pending.cancelled()).toBe(true);
  expect(persisted).toBe(0); expect(cdn).toBe(0);
});

test("CDN fetch timeout aborts HTTP and discards a noncooperative late response", async () => {
  const pending = deferred<Response>();
  const late = hangingBody();
  let signal: AbortSignal | undefined;
  const c = client(async (_url, init) => { signal = init?.signal as AbortSignal; return pending.promise; });
  await expect(c.downloadImage("image")).rejects.toThrow("timed out");
  expect(signal?.aborted).toBe(true);
  pending.resolve(new Response(late.body)); await pause();
  expect(late.cancelled()).toBe(true);
});

test("CDN body deadline cancels its actual reader and rejects consumption", async () => {
  const pending = hangingBody();
  let signal: AbortSignal | undefined;
  const c = client(async (_url, init) => { signal = init?.signal as AbortSignal; return new Response(pending.body, { headers: { "content-type": "audio/mpeg" } }); });
  const downloaded = await c.downloadAudio("audio");
  await expect(new Response(downloaded.body).arrayBuffer()).rejects.toThrow();
  expect(signal?.aborted).toBe(true); expect(pending.cancelled()).toBe(true);
});

test("archive deadline cancels even a custom media source body", async () => {
  const pending = hangingBody();
  let signal: AbortSignal | undefined;
  const chats = { fetchVoiceAudio: async (_r: string, _id: string, _c: MizitoClient, s?: AbortSignal) => {
    signal = s; return { body: pending.body, size: 0, durationSeconds: 2 };
  } } as unknown as ChatService;
  await expect(fetchVoiceMedia(chats, {} as MizitoClient, "Team", id, true, MAX_AUDIO_BYTES, { timeoutMs: 15 })).rejects.toThrow("timed out");
  expect(signal?.aborted).toBe(true); expect(pending.cancelled()).toBe(true);
});

test("seventh options argument propagates explicit cancellation through discovery", async () => {
  const parent = new AbortController();
  const started = deferred<void>();
  const pending = deferred<Response>();
  let signal: AbortSignal | undefined;
  const c = client(async (_url, init) => { signal = init?.signal as AbortSignal; started.resolve(); return pending.promise; }, { mediaTimeoutMs: 1000 });
  const operation = fetchImageMedia(new ChatService(c), c, "Team", id, true, MAX_IMAGE_BYTES, { signal: parent.signal, timeoutMs: 1000 });
  await started.promise; parent.abort(new Error("user cancelled"));
  await expect(operation).rejects.toThrow("user cancelled");
  expect(signal?.aborted).toBe(true);
  pending.reject(new Error("late transport failure")); await pause();
});

test("pre-aborted whole-flow signal prevents authentication and all HTTP calls", async () => {
  const ac = new AbortController(); ac.abort(new Error("cancelled"));
  let calls = 0;
  const c = client(async () => { calls++; throw new Error("unexpected"); }, { token: undefined, beforeLogin: async () => { calls++; } });
  await expect(fetchVoiceMedia(new ChatService(c), c, "Team", id, true, MAX_AUDIO_BYTES, { signal: ac.signal })).rejects.toThrow("cancelled");
  expect(calls).toBe(0);
});

test("history options and resolveChat options propagate the supplied signal", async () => {
  for (const operation of ["history", "resolve"] as const) {
    const ac = new AbortController();
    const started = deferred<void>();
    const pending = hangingBody();
    let signal: AbortSignal | undefined;
    const c = client(async (_url, init) => { signal = init?.signal as AbortSignal; started.resolve(); return new Response(pending.body); });
    const chats = new ChatService(c);
    const result = operation === "history" ? chats.history({ id: "chat", name: "Team", isGroup: true, unread: 0, messagesCount: 0 }, 0, { signal: ac.signal }) : chats.resolveChat("Team", { exact: true, signal: ac.signal });
    await started.promise; ac.abort(new Error("stop read"));
    await expect(result).rejects.toThrow("stop read");
    expect(signal).toBe(ac.signal); expect(pending.cancelled()).toBe(true);
  }
});

test("ordinary no-signal native authentication remains unbounded and uses the unchanged login request", async () => {
  const pending = deferred<void>();
  const requests: { url: string; init?: RequestInit }[] = [];
  let hookSignal: AbortSignal | undefined;
  const persisted: string[] = [];
  const c = client(async (url, init) => {
    requests.push({ url, init });
    return url.endsWith("/create") ? Response.json({ status: 5, token: "new-native" }) : Response.json({ ok: true });
  }, { token: undefined, beforeLogin: (s) => { hookSignal = s; return pending.promise; }, onToken: (token) => { persisted.push(token); } });
  const result = c.post("/api/test", { hello: "world" });
  await pause(25); expect(requests).toHaveLength(0);
  pending.resolve(); expect(await result).toEqual({ ok: true });
  expect(hookSignal).toBeUndefined();
  expect(requests.every((r) => !("signal" in r.init!))).toBe(true);
  expect(JSON.parse(requests[0]!.init!.body as string)).toEqual({ username: "synthetic", password: expect.stringMatching(/^[a-f0-9]{32}\|[a-f0-9]{64}$/), loginCode: "", regId: "" });
  expect(persisted).toEqual(["new-native"]);
});

test("successful media retains native login statuses, token persistence and one CDN 401 retry", async () => {
  const calls: string[] = [], persisted: string[] = [];
  let logins = 0, cdns = 0;
  const c = client(async (url, init) => {
    calls.push(url);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (url.endsWith("/create")) return Response.json({ status: ++logins === 1 ? 5 : 1, token: `session-${logins}` });
    if (url.endsWith("getDialogs")) return Response.json(dialogs);
    if (url.endsWith("getHistory")) return Response.json(voice());
    if (++cdns === 1) return new Response(null, { status: 401 });
    expect((init?.headers as Record<string, string>)["x-token"]).toBe("session-2");
    return new Response(audio, { headers: { "content-type": "audio/mpeg", "content-length": String(audio.length) } });
  }, { token: undefined, mediaTimeoutMs: 1000, onToken: (token) => { persisted.push(token); } });
  const result = await fetchVoiceMedia(new ChatService(c), c, "Team", id, true);
  expect(result.data).toEqual(audio); expect(result.duration_seconds).toBe(2);
  expect(persisted).toEqual(["session-1", "session-2"]); expect(calls).toHaveLength(6);
});

test("successful image supports seventh options while preserving sixth maxBytes", async () => {
  const c = client(async (url) => {
    if (url.endsWith("getDialogs")) return Response.json(dialogs);
    if (url.endsWith("getHistory")) return Response.json(photo());
    return new Response(png, { headers: { "content-type": "image/png" } });
  }, { mediaTimeoutMs: 1000 });
  const result = await fetchImageMedia(new ChatService(c), c, "Team", id, true, png.length, { timeoutMs: 1000 });
  expect(result.data).toEqual(png); expect(result.extension).toBe("png");
  await expect(fetchImageMedia(new ChatService(c), c, "Team", id, true, png.length - 1, { timeoutMs: 1000 })).rejects.toThrow("byte limit");
});

test("nonvoice audio has the compatible UnsupportedAudio subtype", async () => {
  const c = client(async (url) => Response.json(url.endsWith("getDialogs") ? dialogs : voice(false)));
  await expect(fetchVoiceMedia(new ChatService(c), c, "Team", id, true)).rejects.toBeInstanceOf(UnsupportedAudio);
});


test("idle CDN streams are aborted even if the caller never starts consumption", async () => {
  let cancelled = false;
  const c = client(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(audio); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "audio/mpeg" } }));
  const downloaded = await c.downloadAudio("audio");
  await pause(25);
  expect(cancelled).toBe(true);
  await expect(downloaded.body.getReader().read()).rejects.toThrow();
});

test("all signal-aware rejected HTTP and MIME paths cancel response bodies", async () => {
  for (const status of [401, 429, 500]) {
    const bodies: ReturnType<typeof hangingBody>[] = [];
    const c = client(async () => {
      const pending = hangingBody(); bodies.push(pending);
      return new Response(pending.body, { status });
    });
    await expect(c.downloadAudio("audio")).rejects.toThrow();
    expect(bodies.every((body) => body.cancelled())).toBe(true);
  }
  for (const status of [401, 429, 500]) {
    const bodies: ReturnType<typeof hangingBody>[] = [];
    const c = client(async () => {
      const pending = hangingBody(); bodies.push(pending);
      return new Response(pending.body, { status });
    });
    await expect(fetchVoiceMedia(new ChatService(c), c, "Team", id, true)).rejects.toThrow();
    expect(bodies.every((body) => body.cancelled())).toBe(true);
  }
  const pending = hangingBody();
  const c = client(async () => new Response(pending.body, { headers: { "content-type": "text/html" } }));
  await expect(c.downloadAudio("audio")).rejects.toThrow();
  expect(pending.cancelled()).toBe(true);
});

test("timed out noncooperative hook and HTTP rejections remain observed", async () => {
  const hook = deferred<void>();
  const loginFetch = deferred<Response>();
  let requests = 0;
  const c = client(async () => { requests++; return loginFetch.promise; }, { token: undefined, beforeLogin: () => hook.promise });
  await expect(c.downloadAudio("audio")).rejects.toThrow("timed out");
  hook.reject(new Error("late hook failure"));
  await pause(); expect(requests).toBe(0);
  const d = client(async () => loginFetch.promise, { token: undefined });
  await expect(d.downloadImage("image")).rejects.toThrow("timed out");
  loginFetch.reject(new Error("late login transport failure"));
  await pause(); // Bun also fails the test suite on an unhandled rejection.
});

test("history user-id discovery uses the same cancellation signal", async () => {
  const parent = new AbortController();
  const started = deferred<void>();
  const pending = hangingBody();
  let signal: AbortSignal | undefined;
  const c = client(async (url, init) => {
    if (url.endsWith("getHistory")) return Response.json([]);
    if (url.endsWith("getUsers")) return Response.json([]);
    signal = init?.signal as AbortSignal; started.resolve();
    return new Response(pending.body);
  });
  const operation = new ChatService(c).history({ id: "chat", name: "Team", isGroup: true, unread: 0, messagesCount: 0 }, 0, { signal: parent.signal });
  await started.promise; parent.abort(new Error("stop user id"));
  await expect(operation).rejects.toThrow("stop user id");
  expect(signal).toBe(parent.signal); expect(pending.cancelled()).toBe(true);
});
