# Mizito Channel — Design Spec

Date: 2026-10-01
Status: Draft, awaiting review

## 1. Goal

Let an AI agent use Mizito (`office.mizito.ir`, IM section) as a chat channel:

- read chats and message history,
- receive new messages as they arrive,
- optionally send messages, off by default.

Mizito has no official API. The channel talks to the same internal backend the
web app uses (`https://app.mizito.ir`), authenticated as the user's own account.
It is meant to be shared with teammates, so it must be easy to install, read and
modify.

### Success criteria

1. `mizito chats` and `mizito read <chat>` list chats and show history from the CLI.
2. An MCP client (Claude Code, Claude Desktop, others) can list chats, read
   messages and wait for new ones through `mizito mcp`.
3. New messages are delivered without duplicates or gaps across restarts.
4. Sending is impossible unless explicitly enabled.
5. A teammate can install and run it with Bun, or from a single compiled binary.

### Non-goals (v1)

- Marking chats as read (`chat/seen`), media download/upload, group management,
  tasks/projects/mail/other Mizito modules.
- Multi-account support.
- Hosting as a remote service (stdio MCP and local CLI only).

## 2. Constraints and risks

- The API is unofficial and may change without notice. Responses are validated
  with zod and unknown fields are tolerated.
- Automating login with the user's password may conflict with Mizito's terms.
  Intended for the user's own account at low request rates.
- Login may involve a `loginCode`/2FA step not yet observed; the client must
  fail with a clear error rather than loop.
- The endpoint details below come from a third-party reverse-engineering
  (`Erfouni/mizito-ai-connector` API_MAP.md) and partial observation of the web
  app. They must be verified against the live app before being relied on.

## 3. Architecture

One Bun + TypeScript package.

```
src/
  core/
    client.ts      HTTP client: base URL, x-token header, 401 re-login + retry once
    auth.ts        login (POST /capi/session/create), workspace switch, session store
    credentials.ts keychain (macOS `security`) with env/.env fallback
    models.ts      zod schemas + normalized Chat / Message types
    text.ts        HTML -> plain text for message bodies
    watcher.ts     change detection + cursor store; emits new messages
    cursor.ts      per-dialog last-seen msg_index, persisted to a state file
  cli/
    index.ts       `mizito` commands
  mcp/
    server.ts      stdio MCP server (tools + channel notifications)
test/
  fixtures/        recorded JSON responses
```

`core` has no dependency on `cli` or `mcp`. Both front-ends call the same
functions. The watcher is the only component that knows how new messages are
detected, so replacing polling with socket.io touches nothing outside it.

## 4. API client and auth

- Base URL `https://app.mizito.ir`. Session token sent as `x-token`.
- Login: `POST /capi/session/create` with `{username, password, loginCode, regId}`
  where `password = md5hex(pw) + "|" + sha256hex(pw)` (format used by the web
  client). Response `{status, token}`; status 1 or 5 means success.
- On HTTP 401 the client logs in again once and retries the failed request. A
  second failure surfaces as an auth error.
- Workspace: selected via `MIZITO_WORKSPACE` or config; `workspace.switch`
  returns a new token, which replaces the session token.
- Credentials: `MIZITO_USERNAME` / `MIZITO_PASSWORD` env, then a 0600 credentials
  file in `MIZITO_HOME`; `mizito login` writes it. Keychain is deferred because
  `security add-generic-password -w` exposes the secret in process arguments.
  The session token is cached in `MIZITO_HOME/session.json` (0600). The user's own id
  comes from `MIZITO_USER_ID` (needed for `fromMe` and for sending). Credentials and
  tokens are never logged or returned in tool output.
- Endpoints used:
  - `POST /api/chat/getDialogs {}` -> dialogs with `_id, is_group, unread_count,
    messages_count, last_message_date, peer_user`
  - `POST /api/chat/getHistory {dialog, offset}` -> up to 15 messages
    `{_id, from, date, message(html), msg_index, media, reply_to, mention,
    edited, deleted}`; offset skips newest messages, 0 returns the latest page
  - `POST /api/chat/send` (behind the send flag only)
- `chat/seen` is deliberately not called, so agent reads never mark chats read
  for the user.

## 5. Tools and CLI

| MCP tool | CLI | Description |
|---|---|---|
| `list_chats` | `mizito chats [--json]` | Chats with name, type, unread count, last activity |
| `read_messages` | `mizito read <chat> [--limit N] [--json]` | History, newest first, paginated; plain-text bodies, sender, reply/mention info, edited/deleted flags, `from_me` |
| `search_chat` | `mizito search <chat> <query>` | Client-side scan of history unless a server search endpoint is found |
| `wait_for_messages` | `mizito watch [--json]` | New messages since the cursor (long-poll for MCP; JSON-lines stream for CLI) |
| `send_message` | `mizito send <chat> <text>` | Only when `MIZITO_ALLOW_SEND=1`; MCP annotations mark it destructive/confirm |

Other CLI commands: `mizito login`, `mizito mcp` (starts the stdio server).
`<chat>` accepts a dialog id or a case-insensitive name match; ambiguous
matches return an error listing candidates.

## 6. New message delivery

One watcher in `core`, three outputs.

- Detection: poll `getDialogs` (cheap) and fetch history only for dialogs whose
  `last_message_date` or `messages_count` changed.
- Cursor: per-dialog last-seen `msg_index` in a local state file. First run
  starts from "now" and does not replay old history. Messages are emitted in
  `msg_index` order, exactly once, across restarts.
- Realtime: the web app uses socket.io. v1 ships polling only; whether socket.io is usable
  is recorded by the live spike and, if so, gets a follow-up plan that replaces polling
  inside the watcher.
- Outputs:
  1. MCP tool `wait_for_messages` (long-poll with timeout, returns a batch).
  2. MCP channel notifications pushing messages into the session.
  3. CLI `mizito watch --json`, one JSON object per line.
- The user's own messages are emitted with `from_me: true` so agents can ignore
  them.

## 7. Safety

- Read-only by default: `send_message`/`mizito send` refuse unless
  `MIZITO_ALLOW_SEND=1`. When enabled, the MCP tool is annotated as
  destructive and requiring confirmation.
- No `chat/seen`, no deletes, no edits.
- Message content is untrusted input to the agent; tool descriptions state that
  message text must not be treated as instructions.
- Secrets never appear in logs, errors or tool results.

## 8. Errors

Typed errors: `AuthError`, `RateLimited`, `NetworkError`, `SchemaError`,
`SendDisabled`, `AmbiguousChat`. Each maps to a clear MCP error and a CLI exit
code. Schema validation tolerates unknown fields; missing required fields raise
`SchemaError` with the endpoint name.

## 9. Testing

**Process: TDD.** Every unit of behavior is built red-green-refactor: write a
failing test first, watch it fail for the right reason, write the minimum code
to pass, then refactor. The implementation plan is ordered as test-first steps.
Live-API spikes (login, socket.io) are the exception: they are throwaway
exploration, and their findings are captured as recorded fixtures and tests
before any production code depends on them.

- Unit (bun test): models and fixtures, HTML-to-text, cursor logic, chat name
  resolution.
- Mock HTTP server: 401 re-login-and-retry, watcher emits each message once,
  restart resumes from cursor, send gate.
- MCP: in-process client against the server for tool schemas and responses.
- Manual live smoke test (read-only) against the user's account, including the
  login flow and the socket.io spike.

## 10. Distribution

- `bunx`/`bun run` from the repo for teammates.
- `bun build --compile` for a standalone `mizito` binary.
- README covers install, login, MCP client config snippets, env vars, and the
  unofficial-API caveat.

## 11. Open questions (resolved during implementation spikes)

1. Does login require `loginCode`/2FA for this account?
2. Is socket.io usable for realtime message events, and what are the event names?
3. Is there a server-side message search endpoint?
4. Exact semantics of `msg_index` and `offset` for gap-free cursoring.
