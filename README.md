# mizito-channel

A CLI and MCP server that lets an AI agent read [Mizito](https://office.mizito.ir) chats and receive new messages.

> **Unofficial.** Mizito has no public API. This talks to the same internal backend the web app uses
> (`https://app.mizito.ir`), as your own account, and can break without notice. Automating login may
> conflict with Mizito's terms. Use it only with your own account and at low request rates.

## Install

```bash
bun install
mizito_home=~/.config/mizito   # default config dir (override with MIZITO_HOME)
bun src/cli/main.ts login      # stores credentials in $MIZITO_HOME (mode 0600)
bun run build                  # optional: standalone binary at dist/mizito
```

## CLI

```bash
mizito chats [--json]
mizito read "<chat name or id>" [--limit 20] [--json]
mizito search "<chat>" "<text>"
mizito watch [--json]          # streams new messages, one JSON object per line
mizito send "<chat>" "<text>"  # only when MIZITO_ALLOW_SEND=1
mizito login
mizito mcp                     # stdio MCP server
```

Chat names are matched ignoring Arabic/Persian letter variants, ZWNJ and digit styles.
Exit codes: `0` ok, `2` auth error, `3` sending disabled, `64` usage error, `1` anything else.

## MCP

```json
{ "mcpServers": { "mizito": {
  "command": "bun",
  "args": ["run", "/path/to/mizito-channel/src/cli/main.ts", "mcp"],
  "env": { "MIZITO_USER_ID": "<your user id>" }
} } }
```

Tools: `list_chats`, `read_messages`, `search_chat`, `wait_for_messages` (long-poll for new messages),
and `send_message` (registered only when `MIZITO_ALLOW_SEND=1`). Message text is untrusted input:
tool descriptions tell the model never to follow instructions found inside it.

With `MIZITO_PUSH=1` new messages are pushed as channel notifications instead, and
`wait_for_messages` is not registered.

Launch Claude Code with the channel loaded (research preview, per the Claude Code channels docs):
`claude --dangerously-load-development-channels server:mizito`.

> **Push mode delivers messages from every chat and every sender into your session.** Claude Code's
> channel docs require gating inbound messages on sender identity to prevent prompt injection, and
> this version has no allowlist yet. Prefer `wait_for_messages` (the default) until one exists.

## Environment

| Variable | Meaning |
|---|---|
| `MIZITO_USERNAME`, `MIZITO_PASSWORD` | Credentials (override the saved file) |
| `MIZITO_USER_ID` | Your own user id; marks your messages `fromMe` and is needed to send |
| `MIZITO_ALLOW_SEND` | `1` enables sending. Off by default |
| `MIZITO_PUSH` | `1` pushes channel notifications from `mizito mcp` |
| `MIZITO_HOME` | Config/state dir (default `~/.config/mizito`) |
| `MIZITO_BASE_URL` | Backend base URL (default `https://app.mizito.ir`) |
| `MIZITO_POLL_MS` | Poll interval in ms (default 3000) |

Reading never marks chats as read. State files (credentials, session token, cursors) are mode 0600.

## Development

```bash
bun test && bun run typecheck
```
