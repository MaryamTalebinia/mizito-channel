# Opt-in local SQLite chat logger

`src/core/chat-log.ts` is a passive library. Importing it does not collect messages or start a service. The caller must explicitly select exact chat IDs/names and call `run`. There is no watcher, watcher lock/cursor access, send, source write, or mark-read operation. Existing `ChatService` satisfies its injected read-only interface.

**Privacy: the database contains private chat names, sender/message metadata, message text, and actual media bytes in plaintext. It is not encrypted.** Choose a dedicated local directory, protect backups, and do not put it in a public/shared/cloud-synced location without separately deciding that is acceptable. The module emits nothing to stdout. A successful run returns counters only; exceptions contain generic codes, not source errors or signed URLs. Normalized private message text is intentionally preserved, including any secrets people wrote in that text; this is not a content-redaction system.

## Public API

```ts
interface ChatLogSource {
  resolveChat(ref: string, options: { exact: true }): Promise<Chat>;
  history(chat: Chat, offset: number): Promise<Message[]>;
}
interface ChatLogMedia { bytes: Buffer; mime: string; kind: string }
type ChatLogMediaProvider = (
  chat: Chat, message: Message, options: { maxBytes: number },
) => Promise<ChatLogMedia>;

new ChatLogger({
  path: string,
  source: ChatLogSource,
  fetchMedia?: ChatLogMediaProvider,
  maxMediaBytes?: number, // default 20 MiB; valid 1 byte–100 MiB
  busyTimeoutMs?: number, // default 3000; valid 0–30000
});
logger.run({
  chats: string | readonly string[],
  perChatLimit: number, // required, 1–10000 per chat per run
  includeMedia?: boolean, // false by default
  offsets?: Readonly<Record<string, number>>, // explicit backfill offsets by exact chat ID
}): Promise<ChatLogSummary>;
logger.getCheckpoint(chatId: string): ChatLogCheckpoint | null;
logger.close(): void;
```

`ChatLogError` exports a `code` string. `ChatLogSummary` contains numeric counters only: `chats`, `messages` (rows observed this run, not newly inserted rows), `mediaDownloaded`, `mediaFailed`, `mediaUnsupported`, `mediaDisabled` (media outcome rows written this run), and `truncatedChats`. Cached successful BLOBs do not count as newly downloaded. Partial runs throw; previously committed pages remain durable and are inspectable through checkpoints.

`ChatLogCheckpoint` contains `nextOffset`, `hasMore: boolean | null`, `truncated`, `scanned` (this run's committed observations for this chat), and `updatedAt` (local milliseconds). The exact selected chat must resolve to the **literal** supplied ID or name; fuzzy and normalization-only matches are rejected. Chat/message IDs must be literal 24-character hexadecimal strings. No trimming, lowercase conversion, ID repair, wildcard scope, implicit all-chats collection, duplicate selections, or ambiguous scope is accepted. IDs retain original case. Up to 100 explicit chat refs may be supplied.

## Example integration (caller-owned)

```ts
const logger = new ChatLogger({ path: "/private/local/mizito-log/history.sqlite", source: chats });
try {
  const counters = await logger.run({ chats: exactChatId, perChatLimit: 150 });
  // Print counters only, not private content or resolved chat metadata.
} finally {
  logger.close();
}
```

The CLI is wired as `mizito log CHAT [CHAT ...] --db PATH [--limit N] [--media] [--follow] [--interval SECONDS] [--json]`. Defaults are 150 messages per chat and a 30-second follow interval. `--interval` requires `--follow`. Explicit media logging also requires `MIZITO_ALLOW_DOWNLOAD=1`; the native validated in-memory download helpers supply BLOBs without creating temporary files. Foreground follow mode independently rescans the recent window until Ctrl-C. It does not install a background service. A media-disabled invocation fails before collection when `--media` is requested without the gate.

The caller separately wires the CLI and native media download adapter; no authentication behavior changes here. Media requires **both** `includeMedia: true` and an injected provider. Otherwise no provider is called. If the adapter uses existing download helpers, it must additionally enforce their download permission/environment gates, cap the stream/file read to the supplied `maxBytes`, and remove only temporary copies it created. Never return a signed URL or path: return a bounded, nonempty `Buffer`. The module copies that buffer into a real SQLite BLOB and verifies its size again. The provider must enforce bounds before allocating/reading an unbounded response, not rely on the module's post-fetch validation.

Supported normalized attachment kinds are `photo`, `image`, `voice`, and `audio`. Provider `kind` must equal the requested normalized kind; MIME must be a simple `image/*` or `audio/*` MIME (no parameters). Providers are responsible for verifying actual formats and distinguishing supported voice audio from other audio. Documents, videos, and other kinds are recorded as `unsupported` with metadata only, without invoking the provider. Failed/empty/oversized/invalid downloads store a generic error code and NULL bytes, never a downloaded placeholder. Failed or disabled observed media are retried when the same window is scanned again with media enabled. Existing successful, unedited unchanged BLOBs are reused even if media is disabled on a later run. Edited media without a fresh download is no longer labelled downloaded.

## Coverage and continuation

- The source is the existing fixed 15-row history-page contract. Each run processes at most `perChatLimit` messages per selected chat; its last source read can return up to 14 extra rows, which are not persisted or downloaded. Empty or short pages indicate the end according to that contract.
- Default runs always scan from offset zero. This is an idempotent, bounded **recent-window refresh**, not an assurance of complete historical coverage. It sees recent edits/deletions and retries failed recent media without using or modifying watcher cursors. Older changes/failures require rescanning their window explicitly.
- `hasMore: true` means a fetched page contains unprocessed rows, or the last committed full page requires a continuation. `false` means an empty/short final page was reached. `null` means the limit was reached exactly on a full page: no extra probe was made, so whether more rows exist is unknown. `truncated` is true for limit hits with known or possible further rows.
- `nextOffset` is the next **unprocessed source offset**, not an immutable message cursor. To backfill, explicitly pass `{ offsets: { [chatId]: checkpoint.nextOffset } }`. New remote messages can shift offsets; overlapping rescans/idempotent upserts mitigate duplicates, but offset history cannot provide a gap-free snapshot under concurrent remote changes. Do not market a bounded window as a complete archive.
- Each page atomically commits chat metadata, normalized messages, actual media/outcome rows, and its checkpoint. A failure in that transaction advances none of them. A later-page read failure does not erase earlier committed pages. Pages are bounded in memory (15 messages and at most 15 bounded media buffers).
- Composite `(chat_id, message_id)` keys make reruns idempotent and separate identical message IDs across chats. Only **observed** deleted flags are applied; absence from a page/window never fabricates a deletion. An observed deletion or attachment removal drops its obsolete BLOB. There is no immutable edit-history archive.
- Normalized attachment metadata, message text, edit flag and date participate in the cache fingerprint. An edited attachment is conservatively fetched again on every media-enabled scan because the source exposes only a Boolean edit flag, not a reliable revision. Successful unedited unchanged BLOBs are reused. The normalized source has no signed content identifier: replacement bytes on an unedited message with identical metadata/text/date still cannot be detected reliably.

## On-disk safety and schema

New directories are created mode `0700`; the final dedicated parent must be owned by the current user and already `0700` if it exists. The database is created `0600`; existing files with broader/different modes, ownership, symlinks, or multiple hardlinks are rejected rather than silently chmodded. All directory ancestors are checked against symlinks. Use a trusted ancestor: these checks do not defend against an attacker already executing as your own user racing path replacement.

SQLite uses `DELETE` rollback journals, not WAL/SHM. Existing WAL/SHM sidecars are rejected; existing rollback journals must be private regular single-link files. Journal permissions follow the private database and are exercised in tests. Filesystem safety is rechecked before page writes, including database inode identity. Do not open the same file from another application that changes journal mode or permissions. Full synchronous commits, foreign keys, secure-delete, and bounded busy timeout are enabled. Secure-delete is not a guarantee against filesystem snapshots, backups, SSD remanence, or process-memory recovery.

Schema version 1 is created transactionally using `PRAGMA user_version`; unknown versions fail closed. Tables are `metadata`, `chats`, `messages`, `media`, and `checkpoints`. Message `normalized_json` contains only the normalized allowlisted model; raw source objects and unknown fields are discarded. Media status is `downloaded`, `failed`, `disabled`, or `unsupported`. SQL data values are parameterized. No signed source tokens are required or persisted by this module.

## Verification

Run synthetic tests without any account or network access:

```sh
bun test test/chat-log.test.ts
bun run typecheck
```

Tests create real SQLite databases beneath the caller's `TMPDIR` and remove them afterwards. They cover actual BLOB byte equality, compound identity/idempotency, observed edits/deletions, retries/gating/unsupported outcomes, rollback/checkpoint atomicity, bounded continuation, schema/version checks, busy timeout, private journal/file permissions, unsafe links/sidecars, and raw-field/error leakage checks.
