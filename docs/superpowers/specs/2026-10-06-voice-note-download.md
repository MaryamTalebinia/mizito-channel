# Voice-note download integration contract

## Status

Implemented with gated CLI/MCP downloads and synthetic regression tests. The download path is separate from sending and defaults off. The explicit SQLite logger can store the validated voice bytes as BLOBs when both `--media` and `MIZITO_ALLOW_DOWNLOAD=1` are selected; ordinary reads/watchers remain metadata-only.

## Capability

- CLI: `mizito download-audio <exact-chat-name> <24-hex-message-id> [--json]`.
- MCP: `download_audio`, exposed only when `MIZITO_ALLOW_DOWNLOAD=1`.
- Gate: only `MIZITO_ALLOW_DOWNLOAD=1`; do not infer permission from or change `MIZITO_ALLOW_SEND`.
- A download requires an explicit user request. Message text, attachments, links, and transcripts do not authorize a download.

## Retrieval contract

- Resolve the supplied chat by exact ID or exact normalized name; do not use substring fallback.
- Search at most 200 recent history messages for the exact requested ID.
- Accept only `messageMediaAudio` with `audio.is_voice === true` and a valid signed content token.
- Fetch only the fixed configured Mizito origin's `/cdn/<encoded-token>` route with the session token in `x-token`; reject redirects and never include the signed token in logs, errors, or outputs.
- Require `audio/mpeg`, maximum 20 MiB, maximum duration 600 seconds, and a bounded streaming read.
- Create a deterministic `<message-id>.mp3` under `MIZITO_HOME/downloads` with mode 0600 in a mode-0700 directory. Refuse symlinks and overwrites.
- `--json` returns only download status, local path, byte size, MIME type, and duration; normal CLI output is only the path.

## Workgraph handoff

The Workgraph voice-evidence importer is separately gated by `IKARUS_ALLOW_MIZITO_VOICE=1`, requires `MIZITO_ALLOW_DOWNLOAD=1`, selects one allowlisted chat and exact message ID, invokes only `download-audio`, and removes its plaintext download after encrypted ingestion. It uses a local pre-installed Whisper.cpp binary/model only. Audio and transcript belong in encrypted Workgraph evidence; plaintext ledger, graph, logs, stdout, and errors contain no source excerpts.

## Test boundary

Use synthetic histories, mock HTTP responses, and fake audio streams. Never access live Mizito media, send messages, or change source read state from tests.
