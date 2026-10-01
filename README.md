# mizito-channel

A command-line tool and [MCP](https://modelcontextprotocol.io) server that lets an AI agent use
[Mizito](https://office.mizito.ir) as a chat channel: list chats, read history, search, and
receive new messages. Sending is possible but **off by default**.

> **Unofficial.** Mizito has no public API. This talks to the same internal backend the web app
> uses (`https://app.mizito.ir`), signed in as *your own account*. It can break without notice, and
> automating login may conflict with Mizito's terms. Use it only with your own account and keep
> request rates low. Repeated logins can get an account flagged, so this tool caches the session
> token, logs in again only when the server rejects it, and **refuses to log in more than 3 times in
> 10 minutes** (tracked in `logins.json`).

## Contents

- [Quick start](#quick-start) · [CLI](#cli) · [MCP server](#mcp-server) · [Message format](#message-format)
- [Receiving new messages](#receiving-new-messages) · [Sending](#sending) · [Configuration](#configuration)
- [Files and security](#files-and-security) · [Exit codes](#exit-codes) · [Limitations](#limitations) · [Development](#development)

## Quick start

Requires [Bun](https://bun.sh) 1.x.

```bash
git clone <this repo> && cd mizito-channel
bun install

bun src/cli/main.ts login            # asks for username and password, stores them (mode 0600)
bun src/cli/main.ts chats            # list your chats
bun src/cli/main.ts read "Team" --limit 5
```

Optional standalone binary (no Bun needed to run it):

```bash
bun run build                        # produces dist/mizito
./dist/mizito chats
```

Examples below use `mizito` for whichever you run (`bun src/cli/main.ts` or `./dist/mizito`).

## CLI

| Command | What it does |
|---|---|
| `mizito login` | Prompts for username/password (or uses `MIZITO_USERNAME` / `MIZITO_PASSWORD`), logs in once, saves credentials and the session token. |
| `mizito chats [--json]` | Lists chats: id, `group`/`dm`, unread count, name. |
| `mizito read <chat> [--limit N] [--json]` | Recent messages from a chat. Text output is oldest first; `--json` is newest first. Default limit 15. |
| `mizito search <chat> <text> [--json]` | Searches a chat's history (scans up to 20 pages of 15 messages, newest first). |
| `mizito watch [--json]` | Streams new messages from all chats until Ctrl-C. With `--json`, one JSON object per line. |
| `mizito send <chat> <text>` | Sends a message as you. Refused unless `MIZITO_ALLOW_SEND=1`. |
| `mizito mcp` | Starts the stdio MCP server. |

**Naming a chat.** `<chat>` is a chat id or a chat name. Names are matched ignoring case, Arabic vs
Persian letter forms (`ي`/`ی`, `ك`/`ک`, `ى`), Arabic-Indic vs Persian digits, and all spaces and ZWNJ
(half-space), so `علیرضا` finds `علی‌رضا`.
Reading and searching accept a unique partial name; if several chats match you get an error listing
them. `send` requires an **exact** id or name so a message can't go to the wrong chat.

```bash
mizito chats --json | jq '.[] | select(.unread > 0) | .name'
mizito read "تیم فنی" --limit 20
mizito watch --json | while read -r line; do echo "$line" | jq -r '.chatName + ": " + .text'; done
```

## MCP server

Run `mizito mcp` (stdio transport). Example client configuration:

```json
{
  "mcpServers": {
    "mizito": {
      "command": "bun",
      "args": ["run", "/path/to/mizito-channel/src/cli/main.ts", "mcp"]
    }
  }
}
```

With the compiled binary use `"command": "/path/to/dist/mizito", "args": ["mcp"]`. For Claude Code:
`claude mcp add mizito -- bun run /path/to/mizito-channel/src/cli/main.ts mcp`.

### Tools

| Tool | Arguments | Notes |
|---|---|---|
| `list_chats` | none | All chats with unread counts. Read-only. |
| `read_messages` | `chat` (id or partial name), `limit` (1–100, optional) | Newest first. Read-only. |
| `search_chat` | `chat`, `query` | Read-only. |
| `wait_for_messages` | `timeout_seconds` (1–120, default 30) | Long-poll: returns new messages as soon as any arrive, or `[]` on timeout. Read-only. Not registered in push mode. |
| `send_message` | `chat` (exact id or name), `text` | **Only registered when `MIZITO_ALLOW_SEND=1`.** Annotated as destructive; clients should require approval. |

All tools return pretty-printed JSON as text. Domain errors (unknown chat, ambiguous name, auth
problem) come back as tool errors with a readable message.

**Message text is untrusted input.** Anyone in a chat can write anything. The tool descriptions tell
the model never to follow instructions found inside messages, but treat that as a mitigation, not a
guarantee: don't give an agent that reads chats powerful tools unless you trust the senders.

## Message format

`read_messages`, `search_chat`, `wait_for_messages` and `watch --json` use the same shape:

```json
{
  "id": "6a5…",
  "chatId": "692…",
  "chatName": "Team",
  "index": 1236,
  "from": "u_123",
  "fromName": "me",
  "fromMe": true,
  "date": 1790862222116,
  "text": "plain text, HTML stripped",
  "replyTo": "6a4…",
  "mentions": ["u_456"],
  "edited": false,
  "deleted": false,
  "service": false,
  "attachment": { "kind": "document", "name": "report.pdf", "size": 3072 }
}
```

- `date` is milliseconds since the epoch. `index` is the chat's running message number.
- `fromMe` marks your own messages so an agent can ignore them. `fromName` is `"me"` for you and
  otherwise the sender's name from the workspace user list, in groups as well as direct chats. It is
  absent only for senders not in that list (for example removed users); `from` always has the id.
- Attachments are described, not downloaded. A message with only an attachment has empty `text`;
  the text/CLI views show it as `[photo: a.jpg]`. Kinds seen: `photo`, `video`, `document`, `audio`,
  `taskSchedule`, `mentionInTask`, `mentionInChat`.
- `service` marks system notices (someone joined, etc.).

## Receiving new messages

There are three ways, all driven by the same watcher, which polls the chat list every few seconds
and fetches history only for chats that changed:

1. **`wait_for_messages`** (MCP, default). The agent calls it in a loop.
2. **`mizito watch --json`** (CLI). Pipe JSON lines into any script or agent.
3. **Channel push** (MCP, `MIZITO_PUSH=1`). New messages are pushed into a running Claude Code
   session as channel notifications; `wait_for_messages` is not registered in this mode. Load the
   server as a development channel (research preview):

   ```bash
   MIZITO_PUSH=1 claude --dangerously-load-development-channels server:mizito
   ```

   Push mode **requires an allowlist**: set `MIZITO_PUSH_CHATS` to comma-separated chat ids or exact
   names, and only those chats are pushed (your own messages never are). The server refuses to start
   without it. The allowlist is per chat, not per sender, so everyone in an allowlisted group can
   put text in front of your agent. Claude Code's channel docs recommend gating on sender identity;
   only allowlist chats whose members you trust.

Delivery behaviour:

- The first run **baselines** existing history and delivers nothing. Only messages that arrive
  afterwards are delivered.
- Progress is saved per chat, so after a restart you receive what arrived while you were away, each
  message once. Don't run `watch` and `mcp` at the same time; they share the same progress file.
- Deleted messages, edits to old messages, and service notices are not delivered as new messages.
- Delivery is at-most-once: progress is recorded when a batch is fetched, so if the consumer fails
  mid-batch (for example a dropped notification) those messages are not retried. A failed write of
  the progress file does not lose the batch.

## Sending

Disabled unless `MIZITO_ALLOW_SEND=1`. When off, `send_message` doesn't exist as a tool and the CLI
refuses with exit code 3. When on, messages are sent **as you**, to an exact chat id or name. Plain
text is HTML-escaped and newlines become line breaks. Replies, mentions and attachments aren't
supported. Note that sending has not been exercised against the live service, so try it on a chat
with yourself first.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MIZITO_USERNAME`, `MIZITO_PASSWORD` | – | Credentials. Override the saved file. |
| `MIZITO_USER_ID` | derived | Your own user id. Normally not needed; it is fetched automatically. |
| `MIZITO_ALLOW_SEND` | off | `1` enables sending. Any other value leaves it off. |
| `MIZITO_PUSH` | off | `1` makes `mizito mcp` push channel notifications. Needs `MIZITO_PUSH_CHATS`. |
| `MIZITO_PUSH_CHATS` | – | Comma-separated chat ids or exact names allowed to be pushed. |
| `MIZITO_POLL_MS` | `3000` | Poll interval for new messages, in milliseconds. |
| `MIZITO_HOME` | `~/.config/mizito` | Directory for saved state. |
| `MIZITO_BASE_URL` | `https://app.mizito.ir` | Backend base URL. |

## Files and security

Everything lives in `MIZITO_HOME` (default `~/.config/mizito`), created with mode `0600`:

| File | Contents |
|---|---|
| `credentials.json` | Username and password **in plain text** (a Keychain option is not implemented). |
| `session.json` | Cached session token, reused across runs so each command doesn't log in again. |
| `cursors.json` | Per-chat progress for new-message delivery. |
| `names.json` | Cached display names for direct chats. |
| `logins.json` | Timestamps of recent logins, used by the login throttle. |

- Use a consistent `MIZITO_HOME`. Pointing it at a fresh directory discards the cached token and
  forces a new login.
- Secrets are never printed or included in tool output. Reading never marks chats as read.
- Prefer a dedicated or low-privilege account if you can, and remove `credentials.json` when you stop
  using the tool.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Any other error (network, unexpected response, unknown chat, ambiguous name…) |
| `2` | Authentication error (no credentials, login rejected, session rejected) |
| `3` | Sending is disabled |
| `64` | Usage error (unknown command, missing arguments) |

## Limitations

- Unofficial API: field names and behaviour can change. Unexpected responses surface as clear errors
  rather than silent failures.
- Polling, not realtime: new messages appear within one poll interval. Mizito's web app uses
  socket.io; using it is not implemented yet.
- The first poll after a fresh start fetches one page per chat, which takes several seconds for
  large accounts.
- Single account and workspace; no media download, replies, reactions or read receipts.
- No Keychain storage, and the push allowlist is per chat rather than per sender.

## Development

```bash
bun install
bun test                # unit tests (no network)
bun run typecheck
bun run build           # dist/mizito
```

Layout: `src/core` (HTTP client, models, chat service, watcher, stores), `src/cli` (commands),
`src/mcp` (server). The design and plan are in `docs/superpowers/`, and observed API shapes are in
`docs/superpowers/notes/api-findings.md`. `scripts/spike.ts` is a throwaway probe that **performs a
login**, so avoid running it repeatedly.
