import { createHash } from "node:crypto";
import { AuthError, NetworkError } from "./errors";

export interface Credentials {
  username: string;
  password: string;
}

export function hashPassword(pw: string): string {
  const md5 = createHash("md5").update(pw).digest("hex");
  const sha = createHash("sha256").update(pw).digest("hex");
  return `${md5}|${sha}`;
}

export async function login(f: typeof fetch, baseUrl: string, c: Credentials): Promise<string> {
  let res: Response;
  try {
    res = await f(`${baseUrl}/capi/session/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: c.username, password: hashPassword(c.password), loginCode: "", regId: "" }),
    });
  } catch (e) {
    throw new NetworkError(`Could not reach Mizito: ${(e as Error).message}`);
  }
  if (!res.ok) throw new AuthError(`Login failed: HTTP ${res.status}`);
  const body = (await res.json().catch(() => undefined)) as { status?: number; token?: string } | undefined;
  if (!body || (body.status !== 1 && body.status !== 5) || !body.token) {
    throw new AuthError(`Login rejected (status ${body?.status ?? "unknown"})`);
  }
  return body.token;
}
