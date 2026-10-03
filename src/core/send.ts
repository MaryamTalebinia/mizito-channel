import { randomBytes, randomInt } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { Poster, Uploader } from "./client";
import { ConfigError, SchemaError, SendDisabled } from "./errors";

export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ppt": "application/vnd.ms-powerpoint",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "application/xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
};

export function mimeTypeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export interface SendOptions {
  allowSend: boolean;
  userId?: string;
  now?: () => number;
  randomHex?: (bytes: number) => string;
  localId?: () => number;
  randomId?: () => number;
}

type Media = Record<string, unknown>;

function assertSendingAllowed(o: SendOptions): asserts o is SendOptions & { userId: string } {
  if (!o.allowSend) throw new SendDisabled();
  if (!o.userId) throw new ConfigError("MIZITO_USER_ID is required to send messages");
}

function attachmentMessagePayload(chatId: string, text: string, media: Media, o: SendOptions & { userId: string }) {
  const local = (o.localId ?? (() => randomInt(1, 1_000_000_001)))();
  const randomId = (o.randomId ?? (() => randomInt(1, 281_474_976_710_655)))();
  return {
    _: "message",
    _id: local,
    local,
    dialog: chatId,
    out: true,
    message: text,
    media: { ...media, view_as_entity: true, randomId },
    from: o.userId,
    date: (o.now ?? Date.now)(),
    reply_to: null,
    mention: [],
    seen_count: 1,
    randomId,
    pending: true,
  };
}

export async function sendMessage(client: Poster, chatId: string, text: string, o: SendOptions): Promise<void> {
  assertSendingAllowed(o);
  if (!text.trim()) throw new ConfigError("Cannot send an empty message");
  // Preserve the already-proven plain-text payload exactly. Attachment
  // messages use the newer complete web-client shape below.
  const hex = o.randomHex ?? ((n: number) => randomBytes(n).toString("hex"));
  await client.post("/api/chat/send", {
    _: "message",
    _id: hex(12),
    dialog: chatId,
    message: text,
    from: o.userId,
    date: (o.now ?? Date.now)(),
    reply_to: null,
    mention: [],
    randomId: hex(8),
  });
}

interface LocalFile {
  name: string;
  type: string;
  data: Blob;
}

async function loadFiles(paths: string[]): Promise<LocalFile[]> {
  if (paths.length === 0) throw new ConfigError("Send at least one file");
  if (paths.length > MAX_FILES) throw new ConfigError(`Send at most ${MAX_FILES} files at a time`);

  const stats = await Promise.all(paths.map(async (path) => {
    try {
      return { path, stat: await lstat(path) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new ConfigError(`File not found: ${path}`);
      throw new ConfigError(`Cannot access file ${path}: ${(e as Error).message}`);
    }
  }));
  for (const { path, stat } of stats) {
    if (!stat.isFile()) throw new ConfigError(`Path is not a regular file: ${path}`);
    if (stat.size === 0) throw new ConfigError(`File is empty: ${path}`);
    if (stat.size > MAX_FILE_BYTES) throw new ConfigError(`File exceeds the 20 MB limit: ${path}`);
  }

  return Promise.all(paths.map(async (path) => {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      const buffer = await readFile(path);
      bytes = new Uint8Array(buffer.byteLength);
      bytes.set(buffer);
    } catch (e) {
      throw new ConfigError(`Cannot read file ${path}: ${(e as Error).message}`);
    }
    const type = mimeTypeFor(path);
    return { name: basename(path), type, data: new Blob([bytes.buffer], { type }) };
  }));
}

function uploadedMedia(value: unknown): Media {
  if (!value || typeof value !== "object" || Array.isArray(value) || "error" in value) {
    throw new SchemaError("content/upload", "upload response was not a media object");
  }
  const media = value as Media;
  if (typeof media._ !== "string" || !media._.startsWith("messageMedia")) {
    throw new SchemaError("content/upload", "upload response did not contain a Mizito media type");
  }
  return media;
}

export async function sendFiles(
  client: Poster & Uploader,
  chatId: string,
  paths: string[],
  text: string | undefined,
  o: SendOptions,
): Promise<void> {
  assertSendingAllowed(o);
  const files = await loadFiles(paths);
  // Finish every upload before creating any chat message. This avoids a
  // partial delivery when a later upload fails.
  const uploaded: Media[] = [];
  for (const file of files) {
    uploaded.push(uploadedMedia(await client.upload(file.name, file.data, file.type)));
  }
  for (let i = 0; i < uploaded.length; i++) {
    const caption = i === uploaded.length - 1 ? (text ?? "") : "";
    await client.post("/api/chat/send", attachmentMessagePayload(chatId, caption, uploaded[i]!, o));
  }
}
