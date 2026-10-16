import { type Credentials, login } from "./auth";
import { abortable, checkAbort, discard, fetchWithSignal, mediaDeadline, responseBytes, type MediaOptions } from "./abort";
import { MAX_AUDIO_BYTES, MAX_IMAGE_BYTES, MEDIA_TIMEOUT_MS } from "./limits";
import { AuthError, MizitoError, NetworkError, RateLimited, SchemaError } from "./errors";

export interface Poster {
  post(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown>;
}

export interface Uploader {
  upload(fileName: string, data: Blob, mimeType: string): Promise<unknown>;
}

export interface ClientOptions {
  credentials: Credentials;
  baseUrl?: string;
  fetch?: typeof fetch;
  token?: string;
  onToken?: (token: string) => void | Promise<void>;
  beforeLogin?: (signal?: AbortSignal) => Promise<void>;
  /** Test/embedding override may shorten, never extend, the media deadline. */
  mediaTimeoutMs?: number;
}

export class MizitoClient implements Poster, Uploader {
  private token?: string;
  private readonly baseUrl: string;
  private readonly f: typeof fetch;

  constructor(private readonly opts: ClientOptions) {
    this.token = opts.token;
    this.baseUrl = opts.baseUrl ?? "https://app.mizito.ir";
    this.f = opts.fetch ?? fetch;
  }

  async post(path: string, body: unknown = {}, signal?: AbortSignal): Promise<unknown> {
    return this.request(path, () => ({
      method: "POST",
      headers: { "content-type": "application/json", "x-token": this.token ?? "" },
      body: JSON.stringify(body),
    }), signal);
  }

  async upload(fileName: string, data: Blob, mimeType: string): Promise<unknown> {
    const path = "/api/content/upload";
    return this.request(path, () => {
      const form = new FormData();
      form.append("upload", new Blob([data], { type: mimeType }), fileName);
      form.append("sendAsFile", "true");
      return { method: "POST", headers: { "x-token": this.token ?? "" }, body: form };
    });
  }

  async downloadAudio(content: string, options: MediaOptions = {}): Promise<{ body: ReadableStream<Uint8Array>; size: number }> {
    return this.downloadMedia(content, ["audio/mpeg"], MAX_AUDIO_BYTES, options);
  }

  async downloadImage(content: string, options: MediaOptions = {}): Promise<{ body: ReadableStream<Uint8Array>; size: number; mime: string }> {
    return this.downloadMedia(content, ["image/jpeg", "image/png", "image/webp"], MAX_IMAGE_BYTES, options);
  }

  /** Shared with archive helpers so discovery and authentication use the same budget. */
  mediaOperation(options: MediaOptions = {}) {
    return mediaDeadline({ ...options, timeoutMs: Math.min(options.timeoutMs ?? MEDIA_TIMEOUT_MS, this.opts.mediaTimeoutMs ?? MEDIA_TIMEOUT_MS) });
  }

  private async downloadMedia(content: string, accepted: string[], max: number, options: MediaOptions): Promise<{ body: ReadableStream<Uint8Array>; size: number; mime: string }> {
    const deadline = this.mediaOperation(options);
    const signal = deadline.signal;
    let upstream: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let response: Response | undefined;
    let downstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let finished = false;
    const cancel = () => {
      void upstream?.cancel().catch(() => {});
      if (downstream && !finished) {
        downstream.error(new NetworkError("Media download failed"));
        finish();
      }
    };
    const finish = () => {
      finished = true;
      deadline.dispose(); signal.removeEventListener("abort", cancel);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      checkAbort(signal);
      if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,2047}$/.test(content)) throw new SchemaError("cdn", "invalid media token");
      if (!this.token) await this.relogin(signal);
      checkAbort(signal);
      let url: string;
      try {
        const origin = new URL(this.baseUrl);
        if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) throw new Error();
        url = new URL(`/cdn/${encodeURIComponent(content)}`, origin.origin).toString();
      } catch { throw new NetworkError("Invalid Mizito base URL"); }
      const get = () => fetchWithSignal(this.f, url, { method: "GET", headers: { "x-token": this.token ?? "" }, redirect: "error" }, signal);
      let res = response = await get();
      if (res.status === 401) {
        discard(res); await this.relogin(signal); checkAbort(signal); res = response = await get();
        if (res.status === 401) throw new AuthError("Session rejected even after re-login");
      }
      if (res.status === 429) throw new RateLimited();
      if (!res.ok || res.redirected || (res.url && new URL(res.url).origin !== new URL(url).origin)) throw new NetworkError("Media request failed");
      const mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!accepted.includes(mime)) throw new SchemaError("cdn", "unexpected media MIME type");
      const length = res.headers.get("content-length");
      const size = length === null ? 0 : /^[0-9]+$/.test(length) ? Number(length) : NaN;
      if (!Number.isSafeInteger(size) || size < 0 || size > max) throw new NetworkError("Media exceeds byte limit or has invalid length");
      if (!res.body) throw new NetworkError("Media response was empty");
      upstream = res.body.getReader();
      let count = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { downstream = controller; },
        async pull(controller) {
          try {
            const item = await abortable(upstream!.read(), signal);
            checkAbort(signal);
            if (item.done) {
              if (!count || (length !== null && count !== size)) throw new NetworkError("Media response length mismatch");
              finish(); controller.close();
            } else {
              count += item.value.byteLength;
              if (count > max) throw new NetworkError("Media exceeds byte limit");
              controller.enqueue(item.value);
            }
          } catch {
            deadline.cancel(); cancel(); finish();
            controller.error(new NetworkError("Media download failed"));
          }
        },
        cancel() { deadline.cancel(); cancel(); finish(); },
      });
      // Abort even an unconsumed stream; do not retain a live body after its deadline.
      if (!finished) checkAbort(signal);
      return { body, size, mime };
    } catch (e) {
      if (response && !upstream) discard(response);
      deadline.cancel(); cancel(); finish();
      if (e instanceof MizitoError) throw e;
      throw new NetworkError("Could not reach Mizito media service");
    }
  }

  private async request(path: string, init: () => RequestInit, signal?: AbortSignal): Promise<unknown> {
    // Ordinary callers retain the native request/authentication path exactly.
    if (signal) return this.requestWithSignal(path, init, signal);
    if (!this.token) await this.relogin();
    let res = await this.send(path, init());
    if (res.status === 401) {
      await this.relogin();
      res = await this.send(path, init());
      if (res.status === 401) throw new AuthError("Session rejected even after re-login");
    }
    if (res.status === 429) throw new RateLimited();
    if (!res.ok) throw new NetworkError(`HTTP ${res.status} from ${path}`);
    try {
      return await res.json();
    } catch {
      throw new SchemaError(path, "response was not JSON");
    }
  }

  private async requestWithSignal(path: string, init: () => RequestInit, signal: AbortSignal): Promise<unknown> {
    let res: Response | undefined;
    try {
      checkAbort(signal);
      if (!this.token) await this.relogin(signal);
      const send = () => fetchWithSignal(this.f, `${this.baseUrl}${path}`, init(), signal);
      res = await send();
      if (res.status === 401) {
        discard(res); await this.relogin(signal); checkAbort(signal); res = await send();
        if (res.status === 401) throw new AuthError("Session rejected even after re-login");
      }
      if (res.status === 429) throw new RateLimited();
      if (!res.ok) throw new NetworkError(`HTTP ${res.status} from ${path}`);
      const bytes = await responseBytes(res, signal);
      checkAbort(signal);
      try { return JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw new SchemaError(path, "response was not JSON"); }
    } catch (e) {
      if (res) discard(res);
      checkAbort(signal);
      if (e instanceof MizitoError) throw e;
      throw new NetworkError("Could not reach Mizito");
    }
  }

  private async relogin(signal?: AbortSignal): Promise<void> {
    if (signal) {
      checkAbort(signal);
      await abortable(Promise.resolve(this.opts.beforeLogin?.(signal)), signal);
      checkAbort(signal);
      // Reuse native login (credentials, hashing, payload, status semantics).
      // Only its transport is scoped to this media operation's cancellation.
      const scopedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const res = await fetchWithSignal(this.f, String(input), init ?? {}, signal);
        if (!res.ok || !res.body) { discard(res); return res; }
        const bytes = await responseBytes(res, signal);
        checkAbort(signal);
        return new Response(bytes, { status: res.status, statusText: res.statusText, headers: res.headers });
      }) as typeof fetch;
      const token = await abortable(login(scopedFetch, this.baseUrl, this.opts.credentials), signal);
      checkAbort(signal);
      this.token = token;
      await abortable(Promise.resolve(this.opts.onToken?.(token)), signal);
      checkAbort(signal);
      return;
    }
    await this.opts.beforeLogin?.();
    this.token = await login(this.f, this.baseUrl, this.opts.credentials);
    await this.opts.onToken?.(this.token);
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.f(`${this.baseUrl}${path}`, init);
    } catch (e) {
      if (e instanceof MizitoError) throw e;
      // Do not include the fetch exception: runtimes may echo request headers.
      throw new NetworkError("Could not reach Mizito");
    }
  }
}
