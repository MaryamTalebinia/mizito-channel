import { NetworkError } from "./errors";
import { MEDIA_TIMEOUT_MS } from "./limits";

export interface MediaOptions {
  signal?: AbortSignal;
  /** May shorten, never extend, the default operation-wide deadline. */
  timeoutMs?: number;
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new NetworkError("Media operation cancelled");
}

/** Also observes late settlements from non-cooperative hooks/fetch implementations. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal, late?: (value: T) => void): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new NetworkError("Media operation cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then((value) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) { late?.(value); abort(); }
      else resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", abort);
      reject(signal.aborted ? signal.reason : error);
    });
  });
}

export function mediaDeadline(options: MediaOptions = {}) {
  const controller = new AbortController();
  const parent = options.signal;
  const abort = () => controller.abort(parent?.reason ?? new NetworkError("Media operation cancelled"));
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  const requested = options.timeoutMs ?? MEDIA_TIMEOUT_MS;
  const ms = Number.isFinite(requested) ? Math.min(MEDIA_TIMEOUT_MS, Math.max(1, requested)) : MEDIA_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(new NetworkError("Media download timed out")), ms);
  return {
    signal: controller.signal,
    dispose() { clearTimeout(timer); parent?.removeEventListener("abort", abort); },
    cancel() { controller.abort(new NetworkError("Media operation cancelled")); },
  };
}

export function discard(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

export async function fetchWithSignal(f: typeof fetch, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  checkAbort(signal);
  return abortable(f(url, { ...init, signal }), signal, discard);
}

/** Read via our own reader so cancellation also works with synthetic/custom fetch bodies. */
export async function responseBytes(response: Response, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (signal.aborted) { discard(response); checkAbort(signal); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await abortable(reader.read(), signal);
      checkAbort(signal);
      if (item.done) break;
      chunks.push(item.value); size += item.value.length;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } catch (error) { cancel(); throw error; }
  finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}
