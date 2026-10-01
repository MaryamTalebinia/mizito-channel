import type { Chat, Message } from "../src/core/models";
export function scriptedFetch(steps: Array<() => Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const step = steps.shift();
    if (!step) throw new Error("no scripted response left");
    return step();
  }) as typeof fetch;
  return Object.assign(f, { calls });
}

export const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const html = (body: string, status = 200) => () =>
  new Response(body, { status, headers: { "content-type": "text/html" } });

export const msg = (index: number, over: Partial<Message> = {}): Message => ({
  id: `m${index}`, chatId: "c1", chatName: "Chat", index, from: "u2", fromMe: false,
  date: 2000 + index, text: `msg ${index}`, mentions: [], edited: false, deleted: false, ...over,
});

export class FakeChats {
  chats: Chat[] = [];
  private msgs: Record<string, Message[]> = {};
  failFor = new Set<string>();

  addChat(id: string, existing: Message[] = [], isGroup = true): Chat {
    const chat: Chat = {
      id, name: id, isGroup, unread: 0, messagesCount: existing.length,
      lastMessageDate: existing.at(-1)?.date,
    };
    this.chats.push(chat);
    this.msgs[id] = existing.map((m) => ({ ...m, chatId: id }));
    return chat;
  }

  add(chatId: string, m: Message): void {
    this.msgs[chatId]!.push({ ...m, chatId });
    const chat = this.chats.find((c) => c.id === chatId)!;
    chat.messagesCount = this.msgs[chatId]!.length;
    chat.lastMessageDate = m.date;
  }

  edit(chatId: string, index: number, text: string): void {
    const m = this.msgs[chatId]!.find((x) => x.index === index)!;
    m.text = text;
    m.edited = true;
    this.chats.find((c) => c.id === chatId)!.lastMessageDate = m.date + 1;
  }

  async listChats(): Promise<Chat[]> {
    return this.chats.map((c) => ({ ...c }));
  }

  async history(chat: Chat, offset: number): Promise<Message[]> {
    if (this.failFor.has(chat.id)) throw new Error(`history failed for ${chat.id}`);
    return [...this.msgs[chat.id]!].reverse().slice(offset, offset + 15);
  }
}
