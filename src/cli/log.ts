import { parseArgs } from "node:util";
import { ChatLogger, ChatLogError, type ChatLogMediaProvider, type ChatLogSource, type ChatLogSummary } from "../core/chat-log";

export interface ChatLogCliDeps {
  source: ChatLogSource;
  allowDownload: boolean;
  fetchMedia?: ChatLogMediaProvider;
  signal?: AbortSignal;
  out: (text: string) => void;
  err: (text: string) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
const USAGE = "usage: mizito log CHAT [CHAT ...] --db PATH [--limit N] [--media] [--follow] [--interval SECONDS] [--json]";
const pause = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
});
function positive(value: string, max: number): number | undefined {
  if (!/^[1-9][0-9]*$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n <= max ? n : undefined;
}
function format(summary: ChatLogSummary): string {
  return `chats=${summary.chats} messages=${summary.messages} media_downloaded=${summary.mediaDownloaded} media_failed=${summary.mediaFailed} media_unsupported=${summary.mediaUnsupported} media_disabled=${summary.mediaDisabled} truncated_chats=${summary.truncatedChats}`;
}

/** Explicit local collection only; no wildcard scope, background service, or watcher cursor. */
export async function runChatLog(argv: string[], deps: ChatLogCliDeps): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      db: { type: "string" }, limit: { type: "string" }, media: { type: "boolean" },
      follow: { type: "boolean" }, interval: { type: "string" }, json: { type: "boolean" },
    } });
  } catch { deps.err(USAGE); return 64; }
  const { values, positionals } = args;
  const limit = positive(String(values.limit ?? "150"), 10_000);
  const seconds = positive(String(values.interval ?? "30"), 3600);
  if (!positionals.length || typeof values.db !== "string" || !values.db || !limit || !seconds ||
      (values.interval !== undefined && !values.follow)) { deps.err(USAGE); return 64; }
  if (values.media && (!deps.allowDownload || !deps.fetchMedia)) {
    deps.err("Media logging requires MIZITO_ALLOW_DOWNLOAD=1; no messages were collected."); return 4;
  }
  if (deps.signal?.aborted) return 0;
  deps.err("Local SQLite logging: private message text and requested media are stored in plaintext. No source writes or mark-read calls.");
  let logger: ChatLogger | undefined;
  try {
    logger = new ChatLogger({ path: values.db, source: deps.source, ...(values.media ? { fetchMedia: deps.fetchMedia } : {}) });
    do {
      if (deps.signal?.aborted) break;
      const summary = await logger.run({ chats: positionals, perChatLimit: limit, includeMedia: Boolean(values.media), signal: deps.signal });
      deps.out(values.json ? JSON.stringify(summary) : format(summary));
      if (!values.follow || deps.signal?.aborted) break;
      await (deps.sleep ?? pause)(seconds * 1000, deps.signal);
    } while (!deps.signal?.aborted);
    return 0;
  } catch (error) {
    if (deps.signal?.aborted && error instanceof ChatLogError && error.code === "CANCELLED") return 0;
    deps.err(error instanceof ChatLogError ? `Chat logger failed: ${error.code}` : "Chat logger failed.");
    return 1;
  } finally { logger?.close(); }
}
