import type { Poster } from "./client";
import { AmbiguousChat, ChatNotFound } from "./errors";
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

export class ChatService implements ChatSource {
  constructor(private readonly client: Poster, private readonly opts: { userId?: string } = {}) {}

  async listChats(): Promise<Chat[]> {
    return parseDialogs(await this.client.post("/api/chat/getDialogs", {}));
  }

  async history(chat: Chat, offset: number): Promise<Message[]> {
    const raw = await this.client.post("/api/chat/getHistory", { dialog: chat.id, offset });
    return parseHistory(raw, chat, this.opts.userId);
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
