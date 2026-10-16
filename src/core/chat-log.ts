import { Database } from "bun:sqlite";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Chat, Message } from "./models";

/** Read-only capability surface: no watcher, mark-read, auth, or send operations. */
export interface ChatLogSource {
  resolveChat(ref: string, options: { exact: true; signal?: AbortSignal }): Promise<Chat>;
  history(chat: Chat, offset: number, options?: { signal?: AbortSignal }): Promise<Message[]>;
}
export interface ChatLogMedia { bytes: Buffer; mime: string; kind: string }
/** Provider must enforce maxBytes while reading (not after an unbounded allocation). */
export type ChatLogMediaProvider = (chat: Chat, message: Message, options: { maxBytes: number; signal?: AbortSignal }) => Promise<ChatLogMedia>;
export interface ChatLoggerOptions {
  path: string;
  source: ChatLogSource;
  fetchMedia?: ChatLogMediaProvider;
  maxMediaBytes?: number;
  busyTimeoutMs?: number;
}
export interface ChatLogRunOptions {
  chats: string | readonly string[];
  perChatLimit: number;
  includeMedia?: boolean;
  signal?: AbortSignal;
  /** Explicit backfill offsets, keyed by resolved chat ID. Default: rescan newest window. */
  offsets?: Readonly<Record<string, number>>;
}
export interface ChatLogCheckpoint {
  nextOffset: number;
  /** null = limit hit exactly on a full page; no extra remote probe was made. */
  hasMore: boolean | null;
  truncated: boolean;
  scanned: number;
  updatedAt: number;
}
/** Counters only: never content, identifiers, paths, or upstream errors. */
export interface ChatLogSummary {
  chats: number; messages: number; mediaDownloaded: number; mediaFailed: number;
  mediaUnsupported: number; mediaDisabled: number; truncatedChats: number;
}
export class ChatLogError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "ChatLogError"; }
}
export class ChatLogUnsupportedMedia extends Error {
  constructor() { super("UNSUPPORTED_MEDIA"); this.name = "ChatLogUnsupportedMedia"; }
}
const fail = (code: string): never => { throw new ChatLogError(code); };
function cancellable<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work();
  if (signal.aborted) return Promise.reject(new ChatLogError("CANCELLED"));
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); reject(new ChatLogError("CANCELLED")); };
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(() => { if (signal.aborted) throw new ChatLogError("CANCELLED"); return work(); }).then(
      value => { signal.removeEventListener("abort", aborted); if (signal.aborted) reject(new ChatLogError("CANCELLED")); else resolve(value); },
      error => { signal.removeEventListener("abort", aborted); reject(error); },
    );
  });
}
const validId = (v: unknown): v is string => typeof v === "string" && /^[a-fA-F0-9]{24}$/.test(v);
const integer = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const PAGE_SIZE = 15;
const SUPPORTED = new Set(["photo", "image", "voice", "audio"]);
const ownUid = () => process.getuid?.();
const TABLE_COLUMNS: Record<string, string[]> = {
  metadata: ["key:TEXT:1", "value:TEXT:0"],
  chats: ["chat_id:TEXT:1", "name:TEXT:0", "is_group:INTEGER:0", "updated_at:INTEGER:0"],
  messages: ["chat_id:TEXT:1", "message_id:TEXT:2", "text:TEXT:0", "edited:INTEGER:0", "deleted:INTEGER:0", "normalized_json:TEXT:0", "updated_at:INTEGER:0"],
  media: ["chat_id:TEXT:1", "message_id:TEXT:2", "kind:TEXT:0", "fingerprint:TEXT:0", "status:TEXT:0", "error_code:TEXT:0", "mime:TEXT:0", "bytes:BLOB:0", "updated_at:INTEGER:0"],
  checkpoints: ["chat_id:TEXT:1", "next_offset:INTEGER:0", "has_more:INTEGER:0", "truncated:INTEGER:0", "scanned:INTEGER:0", "updated_at:INTEGER:0"],
};
function validateExistingSchema(db: Database): void {
  const objects = db.query("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; type: string }[];
  if (objects.length !== Object.keys(TABLE_COLUMNS).length || objects.some(o => o.type !== "table" || !Object.hasOwn(TABLE_COLUMNS, o.name))) fail("INVALID_SCHEMA");
  for (const [table, expected] of Object.entries(TABLE_COLUMNS)) {
    const columns = db.query("SELECT name,type,pk FROM pragma_table_info(?) ORDER BY cid").all(table) as { name: string; type: string; pk: number }[];
    if (JSON.stringify(columns.map(c => `${c.name}:${c.type}:${c.pk}`)) !== JSON.stringify(expected)) fail("INVALID_SCHEMA");
  }
  const markers = db.query("SELECT key,value FROM metadata ORDER BY key").all() as { key: string; value: string }[];
  if (JSON.stringify(markers) !== JSON.stringify([
    { key: "content_storage", value: "plaintext" }, { key: "format", value: "mizito-chat-log" }, { key: "schema_version", value: "1" },
  ])) fail("INVALID_SCHEMA");
}
function statIfExists(path: string) {
  try { return lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}
function privateFile(path: string) {
  const st = statIfExists(path);
  if (st && (!st.isFile() || st.nlink !== 1 || (st.mode & 0o777) !== 0o600 || st.uid !== ownUid())) fail("UNSAFE_PATH");
  return st;
}
/** Reject symlink ancestors; only the dedicated final directory must be private. */
function preparePath(path: string): string {
  if (!path || path === ":memory:" || path.includes("\0")) fail("UNSAFE_PATH");
  const abs = resolve(path), parent = dirname(abs);
  let current = parse(parent).root;
  for (const part of parent.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    if (!statIfExists(current)) mkdirSync(current, { mode: 0o700 });
    const st = lstatSync(current);
    if (!st.isDirectory() || st.isSymbolicLink()) fail("UNSAFE_PATH");
  }
  const dir = lstatSync(parent);
  if ((dir.mode & 0o777) !== 0o700 || dir.uid !== ownUid()) fail("UNSAFE_PATH");
  privateFile(abs);
  // This logger only opens rollback-journal databases. Never follow pre-existing sidecar links.
  if (statIfExists(`${abs}-wal`) || statIfExists(`${abs}-shm`)) fail("UNSAFE_PATH");
  privateFile(`${abs}-journal`);
  let fd: number;
  try { fd = openSync(abs, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    fd = openSync(abs, constants.O_RDWR | constants.O_NOFOLLOW);
  }
  try {
    const st = fstatSync(fd), onDisk = privateFile(abs);
    if (!onDisk || st.ino !== onDisk.ino || st.dev !== onDisk.dev) fail("UNSAFE_PATH");
  } finally { closeSync(fd); }
  return abs;
}

type Outcome = { status: string; error: string | null; bytes: Buffer | null; mime: string | null; kind: string; fingerprint: string };
function normalized(m: Message, chat: Chat): Message {
  if (!m || !validId(m.id) || m.chatId !== chat.id || !validId(m.chatId) || !integer(m.index, 0, Number.MAX_SAFE_INTEGER) ||
      !Number.isFinite(m.date) || typeof m.text !== "string" || typeof m.sender !== "string" || typeof m.from !== "string" ||
      typeof m.fromMe !== "boolean" || typeof m.edited !== "boolean" || typeof m.deleted !== "boolean" || typeof m.service !== "boolean" ||
      !Array.isArray(m.mentions) || !m.mentions.every(validId) || (m.replyTo !== undefined && !validId(m.replyTo)) ||
      (m.fromName !== undefined && typeof m.fromName !== "string")) fail("INVALID_MESSAGE");
  const a = m.attachment;
  if (a && (typeof a.kind !== "string" || a.kind.length > 64 || (a.name !== undefined && typeof a.name !== "string") ||
    (a.size !== undefined && !integer(a.size, 0, Number.MAX_SAFE_INTEGER)))) fail("INVALID_MESSAGE");
  // Deliberate allowlist: unknown raw/signed source fields can never reach the database/provider.
  return { id: m.id, chatId: m.chatId, chatName: chat.name, sender: m.sender, index: m.index, from: m.from,
    fromName: m.fromName, fromMe: m.fromMe, date: m.date, text: m.text, replyTo: m.replyTo, mentions: [...m.mentions],
    edited: m.edited, deleted: m.deleted, service: m.service,
    ...(a ? { attachment: { kind: a.kind, ...(a.name !== undefined ? { name: a.name } : {}), ...(a.size !== undefined ? { size: a.size } : {}) } } : {}) };
}

export class ChatLogger {
  private readonly db!: Database;
  private readonly path!: string;
  private readonly maxBytes: number;
  private readonly identity!: { ino: number; dev: number };
  private running = false;
  private closed = false;
  constructor(private readonly options: ChatLoggerOptions) {
    this.maxBytes = options.maxMediaBytes ?? 20 * 1024 * 1024;
    const timeout = options.busyTimeoutMs ?? 3000;
    if (!integer(this.maxBytes, 1, 100 * 1024 * 1024) || !integer(timeout, 0, 30_000)) fail("INVALID_OPTIONS");
    let db: Database | undefined;
    try {
      this.path = preparePath(options.path);
      const opened = lstatSync(this.path);
      this.identity = { ino: opened.ino, dev: opened.dev };
      db = new Database(this.path, { strict: true });
      // Inspect identity before any persistent PRAGMA or schema write to an existing database.
      const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version !== 0 && version !== 1) fail("UNSUPPORTED_SCHEMA");
      const objects = db.query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
      if (version === 0 && objects.length) fail("INVALID_SCHEMA");
      if (version === 1) validateExistingSchema(db);
      const mode = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
      if (mode.journal_mode === "wal") fail("UNSAFE_PATH");
      db.exec(`PRAGMA busy_timeout=${timeout}; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;`);
      db.exec("PRAGMA journal_mode=DELETE;");
      if (version === 0) db.transaction(() => {
        db!.exec(`
          CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO metadata VALUES ('format','mizito-chat-log'), ('schema_version','1'), ('content_storage','plaintext');
          CREATE TABLE chats (chat_id TEXT PRIMARY KEY, name TEXT NOT NULL, is_group INTEGER NOT NULL, updated_at INTEGER NOT NULL);
          CREATE TABLE messages (chat_id TEXT NOT NULL REFERENCES chats(chat_id), message_id TEXT NOT NULL,
            text TEXT NOT NULL, edited INTEGER NOT NULL, deleted INTEGER NOT NULL, normalized_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL, PRIMARY KEY(chat_id,message_id));
          CREATE TABLE media (chat_id TEXT NOT NULL, message_id TEXT NOT NULL, kind TEXT NOT NULL, fingerprint TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('downloaded','failed','disabled','unsupported')), error_code TEXT, mime TEXT,
            bytes BLOB, updated_at INTEGER NOT NULL, PRIMARY KEY(chat_id,message_id),
            FOREIGN KEY(chat_id,message_id) REFERENCES messages(chat_id,message_id) ON DELETE CASCADE,
            CHECK((status='downloaded' AND bytes IS NOT NULL AND length(bytes)>0 AND mime IS NOT NULL) OR (status!='downloaded' AND bytes IS NULL)));
          CREATE TABLE checkpoints (chat_id TEXT PRIMARY KEY REFERENCES chats(chat_id), next_offset INTEGER NOT NULL,
            has_more INTEGER, truncated INTEGER NOT NULL, scanned INTEGER NOT NULL, updated_at INTEGER NOT NULL);
          PRAGMA user_version=1;
        `);
      }).immediate();
      this.db = db;
    } catch (e) {
      db?.close();
      if (e instanceof ChatLogError) throw e;
      fail("STORAGE_FAILED");
    }
  }
  close(): void { if (this.running) fail("LOGGER_BUSY"); if (!this.closed) { this.db.close(); this.closed = true; } }
  getCheckpoint(chatId: string): ChatLogCheckpoint | null {
    if (!validId(chatId)) fail("INVALID_SCOPE");
    if (this.closed) fail("LOGGER_CLOSED");
    try {
      const r = this.db.query("SELECT * FROM checkpoints WHERE chat_id=?").get(chatId) as any;
      return r ? { nextOffset: r.next_offset, hasMore: r.has_more === null ? null : Boolean(r.has_more), truncated: Boolean(r.truncated), scanned: r.scanned, updatedAt: r.updated_at } : null;
    } catch { return fail("STORAGE_FAILED"); }
  }
  async run(o: ChatLogRunOptions): Promise<ChatLogSummary> {
    if (this.closed) fail("LOGGER_CLOSED");
    if (this.running) fail("LOGGER_BUSY");
    const refs = typeof o.chats === "string" ? [o.chats] : o.chats;
    if (!Array.isArray(refs) || !refs.length || refs.length > 100 || new Set(refs).size !== refs.length ||
      refs.some(r => typeof r !== "string" || !r || r !== r.trim() || r === "*" || r.length > 512 || /[\x00-\x1f]/.test(r))) fail("INVALID_SCOPE");
    if (!integer(o.perChatLimit, 1, 10_000) || (o.includeMedia !== undefined && typeof o.includeMedia !== "boolean")) fail("INVALID_OPTIONS");
    if (o.includeMedia && !this.options.fetchMedia) fail("MEDIA_PROVIDER_REQUIRED");
    const checkCancelled = () => { if (o.signal?.aborted) fail("CANCELLED"); };
    checkCancelled();
    this.running = true;
    try {
      const chats: Chat[] = [];
      for (const ref of refs) {
        checkCancelled();
        let raw: Chat;
        try { raw = await cancellable(() => this.options.source.resolveChat(ref, { exact: true, ...(o.signal ? { signal: o.signal } : {}) }), o.signal); } catch { checkCancelled(); fail("SOURCE_FAILED"); }
        // Verify literal equality ourselves: fuzzy/normalized matches are NOT exact logger scope.
        if (!raw! || !validId(raw!.id) || typeof raw!.name !== "string" || (ref !== raw!.id && ref !== raw!.name) || chats.some(c => c.id === raw!.id)) fail("INVALID_SCOPE");
        chats.push({ id: raw!.id, name: raw!.name, isGroup: Boolean(raw!.isGroup), unread: 0, messagesCount: 0 });
      }
      for (const [key, value] of Object.entries(o.offsets ?? {})) if (!validId(key) || !chats.some(c => c.id === key) || !integer(value, 0, Number.MAX_SAFE_INTEGER - 10_000)) fail("INVALID_OPTIONS");
      const summary: ChatLogSummary = { chats: 0, messages: 0, mediaDownloaded: 0, mediaFailed: 0, mediaUnsupported: 0, mediaDisabled: 0, truncatedChats: 0 };
      for (const chat of chats) {
        checkCancelled();
        let offset = o.offsets?.[chat.id] ?? 0, scanned = 0;
        const seen = new Set<string>();
        while (scanned < o.perChatLimit) {
          checkCancelled();
          let page: Message[];
          try { page = await cancellable(() => this.options.source.history(chat, offset, o.signal ? { signal: o.signal } : undefined), o.signal); } catch { checkCancelled(); fail("SOURCE_FAILED"); }
          if (!Array.isArray(page!) || page!.length > PAGE_SIZE) fail("INVALID_PAGE");
          const batch = page!.slice(0, o.perChatLimit - scanned).map(m => normalized(m, chat));
          for (const m of batch) { if (seen.has(m.id)) fail("INVALID_PAGE"); seen.add(m.id); }
          const outcomes = new Map<string, Outcome>();
          for (const m of batch) {
            checkCancelled();
            if (!m.attachment || m.deleted) continue;
            const fingerprint = createHash("sha256").update(JSON.stringify([m.attachment, m.edited, m.date, m.text])).digest("hex");
            let prior: any;
            try { prior = this.db.query("SELECT status,fingerprint FROM media WHERE chat_id=? AND message_id=?").get(chat.id, m.id); } catch { fail("STORAGE_FAILED"); }
            // A Boolean edit flag is not a revision: conservatively refresh edited attachments.
            if (["downloaded", "unsupported"].includes(prior?.status) && prior.fingerprint === fingerprint && !m.edited) continue;
            const outcome: Outcome = { status: "disabled", error: null, bytes: null, mime: null, kind: m.attachment.kind, fingerprint };
            if (!SUPPORTED.has(m.attachment.kind)) outcome.status = "unsupported";
            else if (o.includeMedia) {
              outcome.status = "failed";
              if ((m.attachment.size ?? 0) > this.maxBytes) outcome.error = "MEDIA_TOO_LARGE";
              else try {
                const media = await cancellable(() => this.options.fetchMedia!(structuredClone(chat), structuredClone(m), { maxBytes: this.maxBytes, ...(o.signal ? { signal: o.signal } : {}) }), o.signal);
                if (!media || !Buffer.isBuffer(media.bytes) || media.bytes.length === 0 || media.bytes.length > this.maxBytes) outcome.error = "MEDIA_INVALID_SIZE";
                else if (typeof media.mime !== "string" || !/^(image|audio)\/[a-zA-Z0-9.+-]{1,80}$/.test(media.mime) || media.kind !== m.attachment.kind) outcome.error = "MEDIA_INVALID_FORMAT";
                else { outcome.status = "downloaded"; outcome.bytes = Buffer.from(media.bytes); outcome.mime = media.mime; }
              } catch (error) {
                checkCancelled();
                if (error instanceof ChatLogUnsupportedMedia) { outcome.status = "unsupported"; outcome.error = null; }
                else outcome.error = "MEDIA_FETCH_FAILED";
              }
            }
            outcomes.set(m.id, outcome);
          }
          const next = offset + batch.length;
          const atLimit = scanned + batch.length === o.perChatLimit;
          const hasMore = page!.length > batch.length ? true : page!.length < PAGE_SIZE ? false : atLimit ? null : true;
          const truncated = atLimit && hasMore !== false;
          try {
            checkCancelled();
            this.assertPath();
            this.db.transaction(() => {
              const now = Date.now();
              this.db.query("INSERT INTO chats VALUES (?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET name=excluded.name,is_group=excluded.is_group,updated_at=excluded.updated_at").run(chat.id, chat.name, +chat.isGroup, now);
              for (const m of batch) {
                this.db.query(`INSERT INTO messages VALUES (?,?,?,?,?,?,?) ON CONFLICT(chat_id,message_id) DO UPDATE SET
                  text=excluded.text,edited=excluded.edited,deleted=excluded.deleted,normalized_json=excluded.normalized_json,updated_at=excluded.updated_at`)
                  .run(chat.id, m.id, m.text, +m.edited, +m.deleted, JSON.stringify(m), now);
                if (!m.attachment || m.deleted) this.db.query("DELETE FROM media WHERE chat_id=? AND message_id=?").run(chat.id, m.id);
                const v = outcomes.get(m.id);
                if (v) this.db.query(`INSERT INTO media VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(chat_id,message_id) DO UPDATE SET kind=excluded.kind,
                  fingerprint=excluded.fingerprint,status=excluded.status,error_code=excluded.error_code,mime=excluded.mime,bytes=excluded.bytes,updated_at=excluded.updated_at`)
                  .run(chat.id, m.id, v.kind, v.fingerprint, v.status, v.error, v.mime, v.bytes, now);
              }
              this.db.query(`INSERT INTO checkpoints VALUES (?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET next_offset=excluded.next_offset,
                has_more=excluded.has_more,truncated=excluded.truncated,scanned=excluded.scanned,updated_at=excluded.updated_at`)
                .run(chat.id, next, hasMore === null ? null : +hasMore, +truncated, scanned + batch.length, now);
            }).immediate();
          } catch (e) { if (e instanceof ChatLogError) throw e; fail("STORAGE_FAILED"); }
          for (const v of outcomes.values()) {
            if (v.status === "downloaded") summary.mediaDownloaded++;
            else if (v.status === "failed") summary.mediaFailed++;
            else if (v.status === "unsupported") summary.mediaUnsupported++;
            else summary.mediaDisabled++;
          }
          scanned += batch.length; offset = next; summary.messages += batch.length;
          if (truncated) summary.truncatedChats++;
          if (hasMore === false || atLimit) break;
        }
        summary.chats++;
      }
      return summary;
    } finally { this.running = false; }
  }
  private assertPath(): void {
    let current = parse(this.path).root;
    for (const part of dirname(this.path).slice(current.length).split("/").filter(Boolean)) {
      current = join(current, part);
      if (!lstatSync(current).isDirectory()) fail("UNSAFE_PATH");
    }
    const st = privateFile(this.path), dir = lstatSync(dirname(this.path));
    if (!st || st.ino !== this.identity.ino || st.dev !== this.identity.dev || !dir.isDirectory() || (dir.mode & 0o777) !== 0o700 || dir.uid !== ownUid()) fail("UNSAFE_PATH");
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      if (suffix !== "-journal" && statIfExists(this.path + suffix)) fail("UNSAFE_PATH");
      privateFile(this.path + suffix);
    }
  }
}
