import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Credentials } from "./auth";
import { AuthError } from "./errors";

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const v = JSON.parse(await readFile(path, "utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export class FileCredentialStore {
  constructor(private readonly path: string) {}

  async get(): Promise<Credentials | undefined> {
    const v = await readJson(this.path);
    return typeof v?.username === "string" && typeof v.password === "string"
      ? { username: v.username, password: v.password }
      : undefined;
  }

  set(c: Credentials): Promise<void> {
    return writePrivateJson(this.path, { username: c.username, password: c.password });
  }
}

export class FileTokenStore {
  constructor(private readonly path: string) {}

  async get(): Promise<string | undefined> {
    const v = await readJson(this.path);
    return typeof v?.token === "string" ? v.token : undefined;
  }

  set(token: string): Promise<void> {
    return writePrivateJson(this.path, { token });
  }
}

export async function loadCredentials(
  env: Record<string, string | undefined>,
  store?: { get(): Promise<Credentials | undefined> },
): Promise<Credentials> {
  if (env.MIZITO_USERNAME && env.MIZITO_PASSWORD) {
    return { username: env.MIZITO_USERNAME, password: env.MIZITO_PASSWORD };
  }
  const stored = await store?.get();
  if (stored) return stored;
  throw new AuthError("No credentials. Run `mizito login` or set MIZITO_USERNAME and MIZITO_PASSWORD.");
}

export class FileNameCache {
  private constructor(private readonly path: string, private data: Record<string, string>) {}

  static async open(path: string): Promise<FileNameCache> {
    const v = await readJson(path);
    const data: Record<string, string> = {};
    for (const [k, x] of Object.entries(v ?? {})) if (typeof x === "string") data[k] = x;
    return new FileNameCache(path, data);
  }

  get(id: string): string | undefined {
    return this.data[id];
  }

  set(id: string, name: string): void {
    this.data[id] = name;
  }

  save(): Promise<void> {
    return writePrivateJson(this.path, this.data);
  }
}
