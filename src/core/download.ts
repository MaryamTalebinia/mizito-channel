import { abortable, checkAbort, mediaDeadline, type MediaOptions } from "./abort";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ChatService } from "./chats";
import type { MizitoClient } from "./client";
import { MAX_AUDIO_BYTES, MAX_AUDIO_DURATION_SECONDS, MAX_IMAGE_BYTES } from "./limits";
import { ConfigError, DownloadDisabled, MediaLimitError, MizitoError, NetworkError } from "./errors";
import { inspectImage } from "./image";

export { MAX_AUDIO_BYTES } from "./limits";

export interface VoiceMedia { data: Buffer; size: number; mime: "audio/mpeg"; duration_seconds: number }
export interface ImageMedia { data: Buffer; size: number; mime: string; width: number; height: number; variant: string; extension: string }
export interface DownloadResult { path: string; size: number; mime: "audio/mpeg"; duration_seconds: number; downloaded: true }
export interface ImageDownloadResult { path: string; size: number; mime: string; width: number; height: number; variant: string; downloaded: true }

function validate(messageId: string, allowed: boolean): void {
  if (!allowed) throw new DownloadDisabled();
  if (!/^[a-f0-9]{24}$/.test(messageId)) throw new ConfigError("Message id must be exactly 24 lowercase hexadecimal characters");
}

async function collect(body: ReadableStream<Uint8Array>, size: number, max: number, signal: AbortSignal): Promise<Buffer> {
  const reader = body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Buffer[] = [];
  let written = 0;
  try {
    checkAbort(signal);
    if (!Number.isSafeInteger(size) || size < 0 || size > max) throw new MediaLimitError();
    while (true) {
      const item = await abortable(reader.read(), signal);
      checkAbort(signal);
      if (item.done) break;
      written += item.value.byteLength;
      if (written > max) throw new ConfigError("Media exceeds byte limit");
      chunks.push(Buffer.from(item.value));
    }
    if (!written || (size > 0 && size !== written)) throw new NetworkError("Media response length mismatch");
    return Buffer.concat(chunks, written);
  } catch (e) {
    cancel();
    if (e instanceof MizitoError) throw e;
    throw new NetworkError("Media download failed");
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}

function cancelLate(media: { body: ReadableStream<Uint8Array> }): void {
  void media.body.cancel().catch(() => {});
}

/** Explicit gated local bytes for archive callers. Never invoke from read/watch paths. */
export async function fetchVoiceMedia(chats: ChatService, client: MizitoClient, chatName: string, messageId: string, allowed: boolean, maxBytes = MAX_AUDIO_BYTES, options: MediaOptions = {}): Promise<VoiceMedia> {
  validate(messageId, allowed);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new MediaLimitError();
  const deadline = client.mediaOperation?.(options) ?? mediaDeadline(options);
  const signal = deadline.signal;
  try {
    checkAbort(signal);
    const audio = await abortable(chats.fetchVoiceAudio(chatName, messageId, client, signal), signal, cancelLate);
    if (!Number.isFinite(audio.durationSeconds) || audio.durationSeconds <= 0 || audio.durationSeconds > MAX_AUDIO_DURATION_SECONDS) {
      void audio.body.cancel().catch(() => {}); throw new MediaLimitError();
    }
    const data = await collect(audio.body, audio.size, Math.min(maxBytes, MAX_AUDIO_BYTES), signal);
    return { data, size: data.length, mime: "audio/mpeg", duration_seconds: audio.durationSeconds };
  } catch (e) { deadline.cancel(); throw e; }
  finally { deadline.dispose(); }
}

/** Validates MIME, signature, dimensions and lengths; does not perform semantic vision. */
export async function fetchImageMedia(chats: ChatService, client: MizitoClient, chatName: string, messageId: string, allowed: boolean, maxBytes = MAX_IMAGE_BYTES, options: MediaOptions = {}): Promise<ImageMedia> {
  validate(messageId, allowed);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new MediaLimitError();
  const deadline = client.mediaOperation?.(options) ?? mediaDeadline(options);
  const signal = deadline.signal;
  try {
    checkAbort(signal);
    const image = await abortable(chats.fetchImage(chatName, messageId, client, signal), signal, cancelLate);
    const data = await collect(image.body, image.size, Math.min(maxBytes, MAX_IMAGE_BYTES), signal);
    if (data.length !== image.advertisedSize) throw new NetworkError("Image response did not match variant size");
    const inspected = inspectImage(data, image.mime);
    if (inspected.width !== image.width || inspected.height !== image.height) throw new ConfigError("Image dimensions do not match metadata");
    return { data, size: data.length, mime: image.mime, ...inspected, variant: image.variant };
  } catch (e) { deadline.cancel(); throw e; }
  finally { deadline.dispose(); }
}

// Linux dirfd paths pin each directory while operating below it. Fail closed elsewhere;
// pathname lstat/chmod/open sequences are not safe against directory replacement.
async function savePrivate(home: string, filename: string, data: Buffer): Promise<string> {
  if (process.platform !== "linux") throw new ConfigError("Secure media downloads require Linux procfs");
  let parent: Awaited<ReturnType<typeof open>> | undefined;
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let anchored: string | undefined;
  let created = false;
  try {
    const homePath = resolve(home);
    await mkdir(homePath, { recursive: true, mode: 0o700 });
    parent = await open(homePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const realHome = await realpath(`/proc/self/fd/${parent.fd}`);
    const base = `/proc/self/fd/${parent.fd}/downloads`;
    await mkdir(base, { mode: 0o700 }).catch((e) => { if (e.code !== "EEXIST") throw e; });
    directory = await open(base, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    await directory.chmod(0o700);
    anchored = `/proc/self/fd/${directory.fd}/${filename}`;
    file = await open(anchored, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    await file.writeFile(data); await file.sync(); await file.chmod(0o600);
    const path = join(realHome, "downloads", filename);
    const current = await lstat(join(realHome, "downloads"));
    const pinned = await directory.stat();
    const saved = await lstat(path), held = await file.stat();
    if (current.dev !== pinned.dev || current.ino !== pinned.ino || current.isSymbolicLink() || saved.dev !== held.dev || saved.ino !== held.ino || saved.isSymbolicLink()) throw new ConfigError("Download location changed during write");
    return path;
  } catch {
    if (created && anchored && file) {
      // Do not remove an attacker replacement during failure cleanup.
      const a = await lstat(anchored).catch(() => undefined), b = await file.stat().catch(() => undefined);
      if (a && b && a.dev === b.dev && a.ino === b.ino) await unlink(anchored).catch(() => {});
    }
    throw new ConfigError("Download already exists or private destination is unsafe or unavailable");
  } finally {
    await file?.close().catch(() => {}); await directory?.close().catch(() => {}); await parent?.close().catch(() => {});
  }
}

export async function downloadVoice(chats: ChatService, client: MizitoClient, chatName: string, messageId: string, home: string, allowed: boolean): Promise<DownloadResult> {
  const { data, ...metadata } = await fetchVoiceMedia(chats, client, chatName, messageId, allowed);
  const path = await savePrivate(home, `${messageId}.mp3`, data);
  return { path, ...metadata, downloaded: true };
}

export async function downloadImage(chats: ChatService, client: MizitoClient, chatName: string, messageId: string, home: string, allowed: boolean): Promise<ImageDownloadResult> {
  const { data, extension, ...metadata } = await fetchImageMedia(chats, client, chatName, messageId, allowed);
  const path = await savePrivate(home, `${messageId}.${extension}`, data);
  return { path, ...metadata, downloaded: true };
}
