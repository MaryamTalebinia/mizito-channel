import { type Credentials, login } from "./auth";
import { AuthError, MizitoError, NetworkError, RateLimited, SchemaError } from "./errors";

export interface Poster {
  post(path: string, body?: unknown): Promise<unknown>;
}

export interface ClientOptions {
  credentials: Credentials;
  baseUrl?: string;
  fetch?: typeof fetch;
  token?: string;
  onToken?: (token: string) => void | Promise<void>;
}

export class MizitoClient implements Poster {
  private token?: string;
  private readonly baseUrl: string;
  private readonly f: typeof fetch;

  constructor(private readonly opts: ClientOptions) {
    this.token = opts.token;
    this.baseUrl = opts.baseUrl ?? "https://app.mizito.ir";
    this.f = opts.fetch ?? fetch;
  }

  async post(path: string, body: unknown = {}): Promise<unknown> {
    if (!this.token) await this.relogin();
    let res = await this.send(path, body);
    if (res.status === 401) {
      await this.relogin();
      res = await this.send(path, body);
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

  private async relogin(): Promise<void> {
    this.token = await login(this.f, this.baseUrl, this.opts.credentials);
    await this.opts.onToken?.(this.token);
  }

  private async send(path: string, body: unknown): Promise<Response> {
    try {
      return await this.f(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-token": this.token ?? "" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (e instanceof MizitoError) throw e;
      throw new NetworkError(`Could not reach Mizito: ${(e as Error).message}`);
    }
  }
}
