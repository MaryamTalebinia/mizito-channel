import type { ChatSource } from "./chats";
import type { CursorStore } from "./cursor";
import type { Chat, Message } from "./models";

export const MAX_PAGES_PER_CHAT = 50;

export interface WatcherDeps {
  chats: ChatSource;
  cursors: CursorStore;
  now?: () => number;
}

const maxIndex = (msgs: Message[], floor: number) => msgs.reduce((m, x) => Math.max(m, x.index), floor);

export class Watcher {
  private firstPoll = true;
  private readonly startedAt: number;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: WatcherDeps) {
    this.startedAt = (deps.now ?? Date.now)();
  }

  poll(): Promise<Message[]> {
    const run = this.chain.then(() => this.pollOnce());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async pollOnce(): Promise<Message[]> {
    const chats = await this.deps.chats.listChats();
    const out: Message[] = [];
    const errors: unknown[] = [];
    for (const chat of chats) {
      try {
        out.push(...(await this.pollChat(chat)));
      } catch (e) {
        errors.push(e);
      }
    }
    if (chats.length > 0 && errors.length === chats.length) throw errors[0];
    try {
      await this.deps.cursors.save();
    } catch (e) {
      // Progress is still held in memory; don't drop the batch because the disk write failed.
      console.error("mizito: could not save cursors:", e instanceof Error ? e.message : e);
    }
    this.firstPoll = false;
    return out.sort((a, b) => a.date - b.date || a.index - b.index);
  }

  private async pollChat(chat: Chat): Promise<Message[]> {
    const { cursors, chats } = this.deps;
    const prev = cursors.get(chat.id);
    const count = chat.messagesCount;
    const lastDate = chat.lastMessageDate ?? 0;
    // Without either change-detection field we cannot tell "unchanged" from "unknown": always look.
    const hasSignal = count !== 0 || chat.lastMessageDate !== undefined;
    if (prev && hasSignal && prev.count === count && prev.lastDate === lastDate) return [];

    let fresh: Message[];
    let index: number;
    if (!prev && this.firstPoll) {
      index = maxIndex(await chats.history(chat, 0), -1);
      fresh = [];
    } else {
      const floor = prev?.index ?? -1;
      const scan = await this.collectSince(chat, floor, prev ? undefined : this.startedAt);
      fresh = scan.found.filter((m) => !m.deleted && !m.service);
      index = Math.max(floor, scan.maxSeen);
    }
    cursors.set(chat.id, { index, count, lastDate });
    return fresh;
  }

  private async collectSince(
    chat: Chat,
    floor: number,
    notBefore?: number,
  ): Promise<{ found: Message[]; maxSeen: number }> {
    const found: Message[] = [];
    let maxSeen = -1;
    let offset = 0;
    for (let page = 0; page < MAX_PAGES_PER_CHAT; page++) {
      const batch = await this.deps.chats.history(chat, offset);
      if (batch.length === 0) break;
      let reachedOld = false;
      maxSeen = maxIndex(batch, maxSeen);
      for (const m of batch) {
        if (m.index <= floor || (notBefore !== undefined && m.date < notBefore)) reachedOld = true;
        else found.push(m);
      }
      if (reachedOld) break;
      offset += batch.length;
    }
    return { found: found.sort((a, b) => a.index - b.index), maxSeen };
  }
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function waitForMessages(w: { poll(): Promise<Message[]> }, o: WaitOptions): Promise<Message[]> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const start = now();
  for (;;) {
    const msgs = await w.poll();
    if (msgs.length > 0) return msgs;
    if (now() - start + o.intervalMs > o.timeoutMs) return [];
    await sleep(o.intervalMs);
  }
}
