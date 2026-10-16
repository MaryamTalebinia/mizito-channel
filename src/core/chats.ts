import { abortable, checkAbort } from "./abort";
import type { Poster, MizitoClient } from "./client";
import { MAX_AUDIO_BYTES, MAX_AUDIO_DURATION_SECONDS, MAX_IMAGE_BYTES } from "./limits";
import { dimensions } from "./image";
import { AmbiguousChat, AuthError, ChatNotFound, ConfigError, MediaLimitError, SchemaError, UnsupportedAudio, VoiceNotFound } from "./errors";
import { type Chat, type Message, parseDialogs, parseHistory, parseUserNames } from "./models";

export const PAGE_SIZE = 15;
const record = (v: unknown): Record<string, unknown> | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

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

  private async fetchChats(signal?: AbortSignal): Promise<Chat[]> {
    checkAbort(signal);
    return parseDialogs(await abortable(this.client.post("/api/chat/getDialogs", {}, signal), signal));
  }

  async listChats(signal?: AbortSignal): Promise<Chat[]> {
    const chats = await this.fetchChats(signal);
    await this.fillDmNames(chats, signal);
    checkAbort(signal);
    return chats;
  }

  // Direct chats only carry the peer's id; names come from the workspace user list (one call).
  private async fillDmNames(chats: Chat[], signal?: AbortSignal): Promise<void> {
    const missing: Chat[] = [];
    for (const c of chats) {
      if (c.isGroup || !c.peerId) continue;
      const cached = this.names.get(c.peerId);
      if (cached) c.name = cached;
      else missing.push(c);
    }
    if (missing.length === 0) return;
    const byId = await this.userNames(signal);
    checkAbort(signal);
    for (const c of missing) {
      const name = byId.get(c.peerId!);
      if (name) {
        c.name = name;
        this.names.set(c.peerId!, name);
      }
    }
    await abortable(Promise.resolve(this.names.save?.()), signal);
    checkAbort(signal);
  }

  // Workspace user names by id, fetched at most once per TTL. Failures give an empty map (retried next call).
  private async userNames(signal?: AbortSignal): Promise<Map<string, string>> {
    if (signal) {
      checkAbort(signal);
      // Keep operation-scoped requests out of shared native caches.
      try { return parseUserNames(await abortable(this.client.post("/api/workspace/getUsers", {}, signal), signal)); }
      catch (e) { checkAbort(signal); if (e instanceof AuthError) throw e; return new Map(); }
    }
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

  private getUserId(signal?: AbortSignal): Promise<string | undefined> {
    checkAbort(signal);
    if (signal) return this.opts.userId ? Promise.resolve(this.opts.userId) : this.fetchUserId(signal);
    if (this.opts.userId) return Promise.resolve(this.opts.userId);
    this.myId ??= this.fetchUserId().then((id) => {
      if (id === undefined) this.myId = undefined;
      return id;
    });
    return this.myId;
  }

  private async fetchUserId(signal?: AbortSignal): Promise<string | undefined> {
    try {
      checkAbort(signal);
      const r = (await abortable(this.client.post("/api/workspace/userId", {}, signal), signal)) as { uid?: unknown };
      return typeof r?.uid === "string" && r.uid ? r.uid : undefined;
    } catch (e) {
      checkAbort(signal);
      if (e instanceof AuthError) throw e;
      return undefined;
    }
  }

  // Inspect at most 195 entries, even when upstream wraps or overfills a page.
  private async findMedia(ref: string, messageId: string, kind: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!/^[a-f0-9]{24}$/.test(messageId)) throw new ConfigError("Message id must be exactly 24 lowercase hexadecimal characters");
    checkAbort(signal);
    const chat = await abortable(this.resolveChat(ref, { exact: true, signal }), signal);
    for (let offset = 0; offset + PAGE_SIZE <= 200; offset += PAGE_SIZE) {
      checkAbort(signal);
      const raw = await abortable(this.client.post("/api/chat/getHistory", { dialog: chat.id, offset }, signal), signal);
      checkAbort(signal);
      const wrapped = record(raw);
      const page = Array.isArray(raw) ? raw : wrapped?.messages;
      if (!Array.isArray(page) || !page.length) break;
      for (const item of page.slice(0, PAGE_SIZE)) {
        const m = record(item), media = record(m?.media);
        if (!m || m._id !== messageId || m._ !== "message" || m.deleted || m.service || m.is_deleted) continue;
        // History normally has no dialog field; if supplied it must agree exactly.
        if ([m.dialog, m.dialog_id, m.chat_id, m.chatId].some((v) => v !== undefined && (typeof v === "string" ? v : record(v)?._id) !== chat.id)) continue;
        if (media?._ === kind) return media;
      }
      if (page.length < PAGE_SIZE) break;
    }
    if (kind === "messageMediaAudio") throw new VoiceNotFound();
    throw new SchemaError("chat/getHistory", "no eligible image found in bounded recent history");
  }

  async fetchVoiceAudio(ref: string, messageId: string, client: MizitoClient, signal?: AbortSignal): Promise<{ body: ReadableStream<Uint8Array>; size: number; durationSeconds: number }> {
    const media = await this.findMedia(ref, messageId, "messageMediaAudio", signal);
    const audio = record(media.audio);
    if (audio?.is_voice === false) throw new UnsupportedAudio();
    if (!audio || audio.is_voice !== true || typeof audio.content !== "string") throw new VoiceNotFound();
    const durationSeconds = Number(audio.duration), size = Number(audio.size);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_AUDIO_DURATION_SECONDS ||
        (audio.size !== undefined && (!Number.isSafeInteger(size) || size < 0 || size > MAX_AUDIO_BYTES))) throw new MediaLimitError();
    checkAbort(signal);
    return { ...await client.downloadAudio(audio.content, { signal }), durationSeconds };
  }

  async fetchImage(ref: string, messageId: string, client: MizitoClient, signal?: AbortSignal): Promise<{ body: ReadableStream<Uint8Array>; size: number; mime: string; width: number; height: number; variant: string; advertisedSize: number }> {
    const media = await this.findMedia(ref, messageId, "messageMediaPhoto", signal);
    const photo = record(media.photo);
    if (!photo || typeof photo._id !== "string" || typeof photo.name !== "string") throw new SchemaError("chat/getHistory", "invalid image metadata");
    // Fixed preference, never enumerate attacker-controlled keys or follow original filenames.
    for (const variant of ["photo_large", "photo_medium", "photo_small"]) {
      const v = record(photo[variant]);
      if (!v) continue;
      try {
        const d = dimensions(v.w, v.h);
        if (typeof v.content !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,2047}$/.test(v.content) ||
            typeof v.size !== "number" || !Number.isSafeInteger(v.size) || v.size <= 0 || v.size > MAX_IMAGE_BYTES) continue;
        checkAbort(signal);
        return { ...await client.downloadImage(v.content, { signal }), ...d, variant, advertisedSize: v.size };
      } catch (e) {
        if (e instanceof ConfigError) continue;
        throw e;
      }
    }
    throw new SchemaError("chat/getHistory", "no bounded image variant available");
  }

  async history(chat: Chat, offset: number, options: { signal?: AbortSignal } = {}): Promise<Message[]> {
    const signal = options.signal;
    checkAbort(signal);
    const raw = await abortable(this.client.post("/api/chat/getHistory", { dialog: chat.id, offset }, signal), signal);
    checkAbort(signal);
    const users = await this.userNames(signal);
    const userId = await this.getUserId(signal);
    checkAbort(signal);
    return parseHistory(raw, chat, userId, (id) => users.get(id));
  }

  async resolveChat(ref: string, o: { exact?: boolean; signal?: AbortSignal } = {}): Promise<Chat> {
    const signal = o.signal;
    checkAbort(signal);
    const chats = await abortable(this.listChats(signal), signal);
    checkAbort(signal);
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
