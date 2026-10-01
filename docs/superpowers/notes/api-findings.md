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
- Without `dialog`: HTTP 400. With it: `{ _id, title, is_group, ..., participants: [string], notify_settings, settings }`.
- **For DMs `title` is the literal placeholder `to_person` — do not use it as a name.** Groups have a real `title`.

## POST /api/workspace/getUsers `{}`
`{ users: [{_id, first_name, last_name, email, role, deleted, ...}], user_status: [...] }` — 195 users in one call. **DM display name = `first_name last_name` of `users[_id == peer_user]`.**

## POST /api/workspace/userId `{}`
`{ uid, wid, phone, ... }` — **`uid` is the caller's own user id** (contains personal data; never log the full response).

## Auth (verified)
Login with `loginCode: ""` and `regId: ""` succeeds (`POST /capi/session/create`), then `x-token` works on `/api/*`.

## POST /api/chat/getHistory `{dialog, offset}`
- Returns a bare array of 15 messages, newest first. `offset: 15` returns the next 15.
- `msg_index` is contiguous and the newest equals the dialog's `messages_count`.
- Message keys: `_id, from (user id string), date (ISO string), mention [], media (null|object), dialog, msg_index, deleted (bool), edited (bool), reply_to (absent|string), chat_full (null), _ , message`.
- `_` is `"message"` or `"messageService"` (service notices such as joins/leaves; they carry `action: {_: "messageActionChatAddUser", users: [...]}` instead of text).
- `media` (null or object) describes attachments: `{_: "messageMediaPhoto"|"Video"|"Document"|"Audio"|"MentionInChat"|"MentionInTask"|"TaskSchedule", <photo|video|document|audio|task|...>: {...}}`. Photo/video/document inner objects have `name` (video/document also `size`); task cards have `title`. Attachment-only messages have an empty `message`.

## Implemented because of these findings
- DM names via `workspace/getUsers` (one call), cached by peer id in `MIZITO_HOME/names.json`.
- Own user id from `workspace/userId` `uid` (no `MIZITO_USER_ID` needed).
- `messageService` entries are flagged `service` and never delivered as new messages.
- Attachments exposed as `attachment {kind, name?, size?}`; attachment-only messages render as `[photo: a.jpg]`.

## Still unknown
- socket.io URL/events for realtime (not captured; polling ships).
- Server-side search endpoint.
