# Mizito API findings (observed 2026-10-01; file-send shape verified from web-client behavior 2026-10-02)

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

## POST /api/content/upload (multipart)
- Verified from captured web-client behavior and the read-only reference implementation; no live file or message was sent during implementation.
- Header: `x-token: <session token>`. Do not set `content-type` manually; the multipart encoder supplies the boundary.
- Parts: file field `upload`; text field `sendAsFile=true`.
- The JSON response is the media object used by chat sending, for example `{_: "messageMediaDocument", document: {...}}`.
- It follows the normal authenticated request behavior: lazy login, retry once after HTTP 401, HTTP 429 as rate limiting, and JSON/schema/network errors without exposing the token.

## POST /api/chat/send with an attachment
- Web-client message shape: `{_:"message", _id:<local number>, local:<same number>, dialog, out:true, message, media, from, date:<ms>, reply_to:null, mention:[], seen_count:1, randomId:<number>, pending:true}`.
- For attachment messages, `media` is the upload response plus `view_as_entity:true` and the same `randomId` as the outer message.
- Multiple files are separate chat messages. Text/caption is empty on every file except the last.
- Local safety limits in this project: 1–10 regular files, maximum 20 MB each; validate/read all files before the first network request.

## Implemented because of these findings
- DM names via `workspace/getUsers` (one call), cached by peer id in `MIZITO_HOME/names.json`.
- Own user id from `workspace/userId` `uid` (no `MIZITO_USER_ID` needed).
- `messageService` entries are flagged `service` and never delivered as new messages.
- Attachments exposed as `attachment {kind, name?, size?}`; attachment-only messages render as `[photo: a.jpg]`.
- File upload and attachment sending using the web-client multipart and message shapes, guarded by `MIZITO_ALLOW_SEND=1`.

## Still unknown
- socket.io URL/events for realtime (not captured; polling ships).
- Server-side search endpoint.
