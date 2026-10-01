import type { Poster } from "./client";
import { AmbiguousChat, AuthError, ChatNotFound } from "./errors";
import { type Chat, type Message, parseDialogs, parseHistory } from "./models";

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

const NAME_LOOKUP_CONCURRENCY = 5;

export interface ChatServiceOptions {
  userId?: string;
  names?: NameCache;
}

export class ChatService implements ChatSource {
  private readonly names: NameCache;
  private myId?: Promise<string | undefined>;

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

  // Direct chats only carry the peer's id; the display name comes from getFullChat.
  private async fillDmNames(chats: Chat[]): Promise<void> {
    const missing: Chat[] = [];
    for (const c of chats) {
      if (c.isGroup || !c.peerId) continue;
      const cached = this.names.get(c.id);
      if (cached) c.name = cached;
      else missing.push(c);
    }
    let next = 0;
    const worker = async () => {
      while (next < missing.length) {
        const chat = missing[next++]!;
        try {
          const full = (await this.client.post("/api/chat/getFullChat", { dialog: chat.id })) as { title?: unknown };
          if (typeof full?.title === "string" && full.title) {
            chat.name = full.title;
            this.names.set(chat.id, full.title);
          }
        } catch (e) {
          if (e instanceof AuthError) throw e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(NAME_LOOKUP_CONCURRENCY, missing.length) }, worker));
    if (missing.length > 0) await this.names.save?.();
  }

  // My id is the participant of any DM that is not the peer.
  private getUserId(): Promise<string | undefined> {
    if (this.opts.userId) return Promise.resolve(this.opts.userId);
    this.myId ??= this.deriveUserId().then((id) => {
      if (id === undefined) this.myId = undefined;
      return id;
    });
    return this.myId;
  }

  private async deriveUserId(): Promise<string | undefined> {
    try {
      for (const dm of (await this.fetchChats()).filter((c) => !c.isGroup && c.peerId).slice(0, 3)) {
        const full = (await this.client.post("/api/chat/getFullChat", { dialog: dm.id })) as { participants?: unknown };
        const others = Array.isArray(full?.participants) ? full.participants.filter((p) => p !== dm.peerId) : [];
        if (others.length === 1 && typeof others[0] === "string") return others[0];
      }
    } catch (e) {
      if (e instanceof AuthError) throw e;
    }
    return undefined;
  }

  async history(chat: Chat, offset: number): Promise<Message[]> {
    const raw = await this.client.post("/api/chat/getHistory", { dialog: chat.id, offset });
    return parseHistory(raw, chat, await this.getUserId());
  }

  async resolveChat(ref: string, o: { exact?: boolean } = {}): Promise<Chat> {
    const chats = await this.listChats();
    const byId = chats.find((c) => c.id === ref);
    if (byId) return byId;
    const q = normalizeName(ref);
    const exact = chats.filter((c) => normalizeName(c.name) === q);
    const partial = o.exact ? [] : chats.filter((c) => normalizeName(c.name).includes(q));
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
    const q = normalizeName(query);
    const hits: Message[] = [];
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.history(chat, offset);
      if (batch.length === 0) break;
      hits.push(...batch.filter((m) => normalizeName(m.text).includes(q)));
      offset += batch.length;
    }
    return hits;
  }
}
