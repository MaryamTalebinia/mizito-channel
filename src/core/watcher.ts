import type { ChatSource } from "./chats";
import type { CursorEntry, CursorStore } from "./cursor";
import type { Chat, Message } from "./models";

export const MAX_PAGES_PER_CHAT = 50;

export interface WatcherDeps {
  chats: ChatSource;
  cursors: CursorStore;
  now?: () => number;
  lock?: { acquire(): Promise<void> };
}

export interface Batch {
  messages: Message[];
  /** Record the batch as delivered. Idempotent. Until called, the messages are redelivered. */
  commit(): Promise<void>;
}

/** Next batch from a watcher; plain `poll()` sources get a no-op commit. */
export async function nextBatch(w: { poll(): Promise<Message[]>; pollBatch?(): Promise<Batch> }): Promise<Batch> {
  if (w.pollBatch) return w.pollBatch();
  return { messages: await w.poll(), commit: async () => {} };
}

interface ChatResult {
  fresh: Message[];
  entry: CursorEntry;
  immediate: boolean;
}

const maxIndex = (msgs: Message[], floor: number) => msgs.reduce((m, x) => Math.max(m, x.index), floor);

export class Watcher {
  private firstPoll = true;
  private locked = false;
  private lease?: Batch;
  private readonly startedAt: number;
  private chain: Promise<unknown> = Promise.resolve();
  private leaseChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: WatcherDeps) {
    this.startedAt = (deps.now ?? Date.now)();
  }

  /** Fetch and immediately record new messages (at-most-once). */
  async poll(): Promise<Message[]> {
    const batch = await this.pollBatch();
    await batch.commit();
    return batch.messages;
  }

  /** Fetch new messages without recording them; call `commit()` once they are delivered. */
  pollBatch(): Promise<Batch> {
    const run = this.chain.then(() => this.pollOnce());
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Like poll(), but the batch is recorded when the NEXT call arrives (the consumer asking again means it
   * received the last one). `releaseLease()` discards an unacknowledged batch so it is redelivered.
   */
  pollLeased(): Promise<Message[]> {
    const run = this.leaseChain.then(async () => {
      const prev = this.lease;
      this.lease = undefined;
      await prev?.commit();
      const batch = await this.pollBatch();
      if (batch.messages.length > 0) this.lease = batch;
      return batch.messages;
    });
    this.leaseChain = run.then(() => undefined, () => undefined);
    return run;
  }

  releaseLease(): void {
    this.lease = undefined;
  }

  private async saveCursors(): Promise<void> {
    try {
      await this.deps.cursors.save();
    } catch (e) {
      // Progress is still held in memory; don't drop messages because the disk write failed.
      console.error("mizito: could not save cursors:", e instanceof Error ? e.message : e);
    }
  }

  private async pollOnce(): Promise<Batch> {
    if (!this.locked) {
      await this.deps.lock?.acquire();
      this.locked = true;
    }
    const chats = await this.deps.chats.listChats();
    const out: Message[] = [];
    const staged: [string, CursorEntry][] = [];
    const errors: unknown[] = [];
    let appliedNow = false;
    for (const chat of chats) {
      try {
        const r = await this.pollChat(chat);
        if (!r) continue;
        if (r.immediate) {
          this.deps.cursors.set(chat.id, r.entry);
          appliedNow = true;
        } else {
          staged.push([chat.id, r.entry]);
        }
        out.push(...r.fresh);
      } catch (e) {
        errors.push(e);
      }
    }
    if (chats.length > 0 && errors.length === chats.length) throw errors[0];
    this.firstPoll = false;

    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      for (const [id, entry] of staged) this.deps.cursors.set(id, entry);
      if (staged.length > 0 || appliedNow) await this.saveCursors();
    };
    // Nothing to deliver, so nothing can be lost: record cursor advances (deleted/service/edits) right away.
    if (out.length === 0) await commit();
    else if (appliedNow) await this.saveCursors();
    return { messages: out.sort((a, b) => a.date - b.date || a.index - b.index), commit };
  }

  private async pollChat(chat: Chat): Promise<ChatResult | undefined> {
    const { cursors, chats } = this.deps;
    const prev = cursors.get(chat.id);
    const count = chat.messagesCount;
    const lastDate = chat.lastMessageDate ?? 0;
    // Without either change-detection field we cannot tell "unchanged" from "unknown": always look.
    const hasSignal = count !== 0 || chat.lastMessageDate !== undefined;
    if (prev && hasSignal && prev.count === count && prev.lastDate === lastDate) return undefined;

    if (!prev && this.firstPoll) {
      const index = maxIndex(await chats.history(chat, 0), -1);
      return { fresh: [], entry: { index, count, lastDate }, immediate: true };
    }
    const floor = prev?.index ?? -1;
    const scan = await this.collectSince(chat, floor, prev ? undefined : this.startedAt);
    return {
      fresh: scan.found.filter((m) => !m.deleted && !m.service),
      entry: { index: Math.max(floor, scan.maxSeen), count, lastDate },
      immediate: false,
    };
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
