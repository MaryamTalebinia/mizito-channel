import type { Poster } from "./client";
import { AmbiguousChat, AuthError, ChatNotFound } from "./errors";
import { type Chat, type Message, parseDialogs, parseHistory, parseUserNames } from "./models";

export const PAGE_SIZE = 15;

export interface ChatSource {
  listChats(): Promise<Chat[]>;
  history(chat: Chat, offset: number): Promise<Message[]>;
}

export function normalizeName(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/ى/g, "ی")
    .replace(/[‌​]/g, " ")
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export interface NameCache {
  get(id: string): string | undefined;
  set(id: string, name: string): void;
  save?(): Promise<void>;
}

export interface ChatServiceOptions {
  userId?: string;
  names?: NameCache;
}

// Comparison key for chat names: also ignores every space and ZWNJ ("علیرضا" == "علی‌رضا").
const matchKey = (s: string) => normalizeName(s).replace(/ /g, "");

const USERS_TTL_MS = 10 * 60 * 1000;

export class ChatService implements ChatSource {
  private readonly names: NameCache;
  private myId?: Promise<string | undefined>;
  private users?: { at: number; map: Promise<Map<string, string>> };

  constructor(private readonly client: Poster, private readonly opts: ChatServiceOptions = {}) {
    const mem = new Map<string, string>();
    this.names = opts.names ?? { get: (id) => mem.get(id), set: (id, n) => void mem.set(id, n) };
  }

  private async fetchChats(): Promise<Chat[]> {
    return parseDialogs(await this.client.post("/api/chat/getDialogs", {}));
  }

  async listChats(): Promise<Chat[]> {
    const chats = await this.fetchChats();
    await this.fillDmNames(chats);
    return chats;
  }

  // Direct chats only carry the peer's id; names come from the workspace user list (one call).
  private async fillDmNames(chats: Chat[]): Promise<void> {
    const missing: Chat[] = [];
    for (const c of chats) {
      if (c.isGroup || !c.peerId) continue;
      const cached = this.names.get(c.peerId);
      if (cached) c.name = cached;
      else missing.push(c);
    }
    if (missing.length === 0) return;
    const byId = await this.userNames();
    for (const c of missing) {
      const name = byId.get(c.peerId!);
      if (name) {
        c.name = name;
        this.names.set(c.peerId!, name);
      }
    }
    await this.names.save?.();
  }

  // Workspace user names by id, fetched at most once per TTL. Failures give an empty map (retried next call).
  private async userNames(): Promise<Map<string, string>> {
    if (!this.users || Date.now() - this.users.at > USERS_TTL_MS) {
      const map = this.client.post("/api/workspace/getUsers", {}).then(parseUserNames);
      this.users = { at: Date.now(), map };
    }
    try {
      return await this.users.map;
    } catch (e) {
      this.users = undefined;
      if (e instanceof AuthError) throw e;
      return new Map();
    }
  }

  private getUserId(): Promise<string | undefined> {
    if (this.opts.userId) return Promise.resolve(this.opts.userId);
    this.myId ??= this.fetchUserId().then((id) => {
      if (id === undefined) this.myId = undefined;
      return id;
    });
    return this.myId;
  }

  private async fetchUserId(): Promise<string | undefined> {
    try {
      const r = (await this.client.post("/api/workspace/userId", {})) as { uid?: unknown };
      return typeof r?.uid === "string" && r.uid ? r.uid : undefined;
    } catch (e) {
      if (e instanceof AuthError) throw e;
      return undefined;
    }
  }

  async history(chat: Chat, offset: number): Promise<Message[]> {
    const raw = await this.client.post("/api/chat/getHistory", { dialog: chat.id, offset });
    const users = await this.userNames();
    return parseHistory(raw, chat, await this.getUserId(), (id) => users.get(id));
  }

  async resolveChat(ref: string, o: { exact?: boolean } = {}): Promise<Chat> {
    const chats = await this.listChats();
    const byId = chats.find((c) => c.id === ref);
    if (byId) return byId;
    const q = matchKey(ref);
    const exact = chats.filter((c) => matchKey(c.name) === q);
    const partial = o.exact ? [] : chats.filter((c) => matchKey(c.name).includes(q));
    const pool = exact.length > 0 ? exact : partial;
    if (pool.length === 0) throw new ChatNotFound(ref);
    if (pool.length > 1) throw new AmbiguousChat(ref, pool.map((c) => c.name));
    return pool[0]!;
  }

  async readMessages(ref: string, o: { limit?: number; offset?: number } = {}): Promise<Message[]> {
    const chat = await this.resolveChat(ref);
    const limit = o.limit ?? PAGE_SIZE;
    const out: Message[] = [];
    let offset = o.offset ?? 0;
    while (out.length < limit) {
      const page = await this.history(chat, offset);
      if (page.length === 0) break;
      out.push(...page);
      offset += page.length;
    }
    return out.slice(0, limit);
  }

  async search(ref: string, query: string, maxPages = 20): Promise<Message[]> {
    const chat = await this.resolveChat(ref);
    const q = matchKey(query);
    const hits: Message[] = [];
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.history(chat, offset);
      if (batch.length === 0) break;
      hits.push(...batch.filter((m) => matchKey(m.text).includes(q)));
      offset += batch.length;
    }
    return hits;
  }
}
