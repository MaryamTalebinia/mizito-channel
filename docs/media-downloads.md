# Explicit inbound media access

## Authority and data boundary

Download is off by default. Only `MIZITO_ALLOW_DOWNLOAD=1` enables it; sending permission is unrelated.
CLI `download-image` / `download-audio` and MCP `download_image` / `download_audio` take an exact chat
id/full name and literal 24-lowercase-hex message id. Existing normalized exact chat-name matching
is retained; partial matching is not allowed. Normal read/search/watch/list paths never fetch media.
Chat text, filenames and attachment content cannot authorize downloads or subsequent tool actions.

Image discovery is based on a bounded read-only observation of metadata, not a live image download:
`messageMediaPhoto.photo` has `_id`, `name`, and `photo_small` / `photo_medium` / `photo_large` objects
containing `content`, `w`, `h`, `size` and `content_key`. No image MIME field was observed. Selection
uses large then medium then small, skipping missing/invalid/out-of-policy variants before fetching
one. Variant dimensions/size must be positive finite safe integers within bounds. Content-key values
are never consumed or emitted. Names never affect destination filenames. Synthetic fixtures exercise
this shape. **Actual image CDN bytes and live image interoperability are not yet verified.** No private
media was fetched during development. Any unexpected MIME, signature or dimension mismatch fails
closed, rather than assuming the unverified backend behavior.

Only `/cdn/<encoded internal content identifier>` on the configured origin is accessed. Tokens are
headers only. No redirects, arbitrary URLs, cloud calls or semantic processing. Existing native
single-relogin behavior is reused, not replaced. Response MIME must be `image/jpeg`, `image/png` or
`image/webp`; signatures, structural boundaries and dimensions must agree. Truncated containers/end
markers, empty/oversized streams, invalid Content-Length, mismatched metadata sizes/dimensions,
animated PNG/WebP and dimension/pixel bombs are rejected. Header/container validation is not a full
codec integrity check, CRC verification, rendering sandbox or malware scan; any later decoder must
apply its own resource limits. JPEG entropy corruption and invalid compressed image data may only
be detected by that later decoder. Maximums: 20 MiB, 16,384 per axis, 40 million pixels; media deadline
30 seconds. Voice retains `audio/mpeg`, 20 MiB and ten-minute duration bounds.

History discovery checks at most 195 entries in 13 pages and supports bare/wrapped histories. Each
page is sliced to 15 before inspection even if upstream returns more. Deleted, service and explicit
wrong-chat entries are excluded; absent dialog fields rely on the exact dialog-scoped history endpoint.

## Local files and API

Downloads return only a local path and safe metadata. Existing destinations (including hardlinks and
symlinks) are never overwritten. The Linux writer opens directories with `O_DIRECTORY|O_NOFOLLOW`,
pins them via `/proc/self/fd`, uses exclusive/no-follow creation, descriptor-based chmod (directory
0700/file 0600), verifies directory/file identity before returning and cleans up failed files. Directory
replacement cannot redirect writes to a symlink target; changed output paths fail closed. This depends
on Linux procfs and rejects unsupported platforms. No userspace implementation can protect against
a hostile process with the same UID modifying the returned path afterward; downstream consumers
must apply their own file-open validation. Use a trusted private `MIZITO_HOME` parent.

Exports in `src/core/download.ts`:

```ts
fetchImageMedia(chats: ChatService, client: MizitoClient, chatName: string,
  messageId: string, allowed: boolean): Promise<ImageMedia>
// { data: Buffer, size, mime, width, height, variant, extension }
fetchVoiceMedia(chats: ChatService, client: MizitoClient, chatName: string,
  messageId: string, allowed: boolean): Promise<VoiceMedia>
// { data: Buffer, size, mime: "audio/mpeg", duration_seconds }
downloadImage(chats, client, chatName, messageId, home: string, allowed): Promise<ImageDownloadResult>
downloadVoice(chats, client, chatName, messageId, home: string, allowed): Promise<DownloadResult>
```

Gated in-memory helpers allow an explicitly authorized local archive caller to persist actual bytes
without temporary files or duplicate-download filename collisions. They independently re-fetch the
exact bounded history and enforce actual photo/voice flags, ignoring any claimed attachment kind
from a caller. They never return content identifiers, keys, filenames or session tokens. Bytes are
returned only to that explicit caller; do not serialize them into MCP/CLI metadata or send to a cloud.
The caller supplies the semantic attachment kind (`photo`/`audio`) from the selected helper, not
untrusted metadata. Lower-level `ChatService.fetchImage` / `fetchVoiceAudio` return cancellable
streams for transport composition; entry points must enforce the gate (prefer the in-memory helpers).

Saving/accessing media does not analyze it. Vision/OCR/transcription requires a separate explicit
subsequent action outside this connector. Media and messages remain untrusted data.
