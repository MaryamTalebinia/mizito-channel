import { createHash, createHmac } from "node:crypto";
import { Backoff } from "./backoff";
import { NetworkError, RateLimited } from "./errors";
import type { Message } from "./models";
import { type Batch, nextBatch } from "./watcher";

export const HERMES_EVENT_TYPE = "mizito_messages";

export interface HermesPayload {
  event_type: typeof HERMES_EVENT_TYPE;
  delivery_id: string;
  detected_at: string;
  messages: Message[];
}

export interface HermesDelivery {
  deliveryId: string;
  payload: HermesPayload;
  body: string;
}

export type HermesFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

export interface HermesWatchOptions {
  url: string;
  secret: string;
  pollIntervalMs: number;
  fetch?: HermesFetch;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  onRetry?: (message: string) => void;
}

type BatchWatcher = { poll(): Promise<Message[]>; pollBatch?(): Promise<Batch> };

function safeMessage(m: Message): Message {
  return {
    sender: m.sender,
    id: m.id,
    chatId: m.chatId,
    chatName: m.chatName,
    index: m.index,
    from: m.from,
    ...(m.fromName !== undefined ? { fromName: m.fromName } : {}),
    fromMe: m.fromMe,
    date: m.date,
    text: m.text,
    ...(m.replyTo !== undefined ? { replyTo: m.replyTo } : {}),
    mentions: [...m.mentions],
    edited: m.edited,
    deleted: m.deleted,
    service: m.service,
    ...(m.attachment ? {
      attachment: {
        kind: m.attachment.kind,
        ...(m.attachment.name !== undefined ? { name: m.attachment.name } : {}),
        ...(m.attachment.size !== undefined ? { size: m.attachment.size } : {}),
      },
    } : {}),
  };
}

export function createHermesDelivery(messages: Message[], now: () => number = Date.now): HermesDelivery {
  const safe = messages.filter((m) => !m.fromMe).map(safeMessage);
  const ids = safe.map((m) => m.id).sort();
  const deliveryId = createHash("sha256").update(JSON.stringify(ids)).digest("hex");
  const payload: HermesPayload = {
    event_type: HERMES_EVENT_TYPE,
    delivery_id: deliveryId,
    detected_at: new Date(now()).toISOString(),
    messages: safe,
  };
  return { deliveryId, payload, body: JSON.stringify(payload) };
}

class WebhookError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "WebhookError";
  }
}

const aborted = () => new DOMException("The operation was aborted", "AbortError");

async function fetchWithTimeout(
  fetcher: HermesFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  if (signal?.aborted) throw aborted();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (signal?.aborted) throw aborted();
    if (controller.signal.aborted) throw new WebhookError(`Hermes webhook timed out after ${timeoutMs}ms`, true);
    throw new WebhookError(`Hermes webhook network error: ${e instanceof Error ? e.message : String(e)}`, true);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function sleepUnlessAborted(ms: number, sleep: (ms: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw aborted();
  if (!signal) return sleep(ms);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(aborted());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(ms).then(
      () => { signal.removeEventListener("abort", onAbort); resolve(); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

export async function postHermesDelivery(delivery: HermesDelivery, o: HermesWatchOptions): Promise<void> {
  const fetcher = o.fetch ?? fetch;
  const maxAttempts = Math.max(1, o.maxAttempts ?? 5);
  const timeoutMs = Math.max(1, o.timeoutMs ?? 10_000);
  const retryBaseMs = Math.max(1, o.retryBaseMs ?? 1_000);
  const retryMaxMs = Math.max(retryBaseMs, o.retryMaxMs ?? 30_000);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const signature = `sha256=${createHmac("sha256", o.secret).update(delivery.body).digest("hex")}`;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchWithTimeout(fetcher, o.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": HERMES_EVENT_TYPE,
          "X-GitHub-Delivery": delivery.deliveryId,
        },
        body: delivery.body,
      }, timeoutMs, o.signal);
      if (response.ok) return;
      const retryable = response.status === 429 || response.status >= 500;
      throw new WebhookError(
        retryable
          ? `Hermes webhook returned retryable HTTP ${response.status}`
          : `Hermes webhook returned permanent HTTP ${response.status}`,
        retryable,
      );
    } catch (e) {
      if (o.signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) throw aborted();
      const error = e instanceof WebhookError
        ? e
        : new WebhookError(`Hermes webhook network error: ${e instanceof Error ? e.message : String(e)}`, true);
      if (!error.retryable) throw error;
      lastError = error;
      if (attempt === maxAttempts) break;
      const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** (attempt - 1));
      o.onRetry?.(`${error.message}; retrying in ${delay}ms (attempt ${attempt + 1}/${maxAttempts})`);
      await sleepUnlessAborted(delay, sleep, o.signal);
    }
  }
  throw new WebhookError(`${lastError?.message ?? "Hermes webhook failed"} after ${maxAttempts} attempts`, true);
}

export async function runHermesWatch(watcher: BatchWatcher, o: HermesWatchOptions): Promise<void> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollBackoff = new Backoff({ baseMs: o.pollIntervalMs });
  while (!o.signal?.aborted) {
    let batch: Batch;
    try {
      batch = await nextBatch(watcher);
    } catch (e) {
      if (!(e instanceof RateLimited || e instanceof NetworkError)) throw e;
      const delay = pollBackoff.next(e instanceof RateLimited ? "rateLimited" : "error");
      o.onRetry?.(`${e.message}; retrying Mizito poll in ${delay}ms`);
      try {
        await sleepUnlessAborted(delay, sleep, o.signal);
      } catch (sleepError) {
        if (o.signal?.aborted || (sleepError instanceof DOMException && sleepError.name === "AbortError")) return;
        throw sleepError;
      }
      continue;
    }
    const incoming = batch.messages.filter((m) => !m.fromMe);
    if (incoming.length > 0) {
      try {
        await postHermesDelivery(createHermesDelivery(incoming, o.now), o);
      } catch (e) {
        if (o.signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        throw e;
      }
    }
    await batch.commit();
    if (o.signal?.aborted) return;
    const delay = pollBackoff.next(incoming.length > 0 ? "messages" : "idle");
    try {
      await sleepUnlessAborted(delay, sleep, o.signal);
    } catch (e) {
      if (o.signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
      throw e;
    }
  }
}
