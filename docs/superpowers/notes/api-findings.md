# Mizito API findings (observed 2026-10-01, shapes only)

Observed by running read-only calls from inside a logged-in web session (the `x-token` stayed in the page).
No message text or tokens are recorded here. **Not yet verified:** the login endpoint (needs a password).

## Auth
- Token is a JWT whose payload has only `jti`, `iat` — no user id. Stored in `localStorage.token`.
- `localStorage.last_login_uid` is NOT a user id (not a 24-hex id).

## POST /api/chat/getDialogs `{}`
`{ dialogs: [...], pin_dialogs: [] }` — 89 dialogs (22 groups, 67 DMs) for the test account.
- Common: `_id, is_group, is_public_group, is_customer_entity, unread_count, history_unread_count, messages_count, last_message_date (ISO string), seen: [{user, seen_count}]`.
- Group: also `title`, `photo`, `pinned_messages`, `group_admins`, `is_project_group`.
- **DM: `peer_user` is a plain string (user id). No name, no `title`.** All dialogs have a `title` or `peer_user`.

## POST /api/chat/getFullChat `{dialog}`
- Without `dialog`: HTTP 400.
- With `dialog`: `{ _id, title, is_group, ..., participants: [string], notify_settings, settings }`.
- **DMs have `title` (the display name) and exactly 2 `participants`.** The participant that is not `peer_user` is the caller's own user id (identical across all 8 DMs checked).
- Groups: `title` present; `participants` are strings.

## POST /api/chat/getHistory `{dialog, offset}`
- Returns a bare array of 15 messages, newest first. `offset: 15` returns the next 15.
- `msg_index` is contiguous and the newest equals the dialog's `messages_count`.
- Message keys: `_id, from (user id string), date (ISO string), mention [], media (null|object), dialog, msg_index, deleted (bool), edited (bool), reply_to (absent|string), chat_full (null), _ , message`.
- `_` is `"message"` or `"messageService"` (service notices such as joins/leaves).

## Implemented because of these findings
- DM names via `getFullChat {dialog}` title, cached in `MIZITO_HOME/names.json`.
- Own user id derived from DM `participants` minus `peer_user` (no `MIZITO_USER_ID` needed).
- `messageService` entries are flagged `service` and never delivered as new messages.

## Still unknown
- Login request details (`loginCode`, `regId`, 2FA) — the user ran `mizito login`; outcome not seen.
- socket.io URL/events for realtime (not captured; polling ships).
- Server-side search endpoint.
