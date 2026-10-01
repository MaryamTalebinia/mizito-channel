import { expect, test } from "bun:test";
import { SchemaError } from "../src/core/errors";
import { describeMessage, parseDialogs, parseHistory } from "../src/core/models";

const dm = { id: "d1", name: "Ata", isGroup: false };
const group = { id: "g1", name: "Team", isGroup: true };

test("parseDialogs maps a person and a group", () => {
  const chats = parseDialogs({
    dialogs: [
      { _id: "d1", is_group: false, unread_count: 2, messages_count: 10, last_message_date: 1700000000000,
        peer_user: { _id: "u2", first_name: "Ata", last_name: "Rezazad" } },
      { _id: "g1", is_group: true, title: "Team", unread_count: 0, messages_count: 3 },
    ],
    pin_dialogs: [],
  });
  expect(chats).toEqual([
    { id: "d1", name: "Ata Rezazad", peerId: "u2", isGroup: false, unread: 2, messagesCount: 10, lastMessageDate: 1700000000000 },
    { id: "g1", name: "Team", isGroup: true, unread: 0, messagesCount: 3, lastMessageDate: undefined },
  ]);
});

test("parseDialogs accepts ISO date strings and numeric strings", () => {
  const [a, b] = parseDialogs({
    dialogs: [
      { _id: "a", last_message_date: "2024-01-01T00:00:00.000Z" },
      { _id: "b", last_message_date: "1700000000000" },
    ],
  });
  expect(a!.lastMessageDate).toBe(Date.parse("2024-01-01T00:00:00.000Z"));
  expect(b!.lastMessageDate).toBe(1700000000000);
});

test("parseDialogs falls back to the id when no name is available", () => {
  expect(parseDialogs({ dialogs: [{ _id: "zzz" }] })[0]!.name).toBe("zzz");
});

test("parseDialogs raises SchemaError naming the endpoint", () => {
  expect(() => parseDialogs({ nope: 1 })).toThrow(SchemaError);
  expect(() => parseDialogs({ nope: 1 })).toThrow(/chat\/getDialogs/);
});

test("parseDialogs tolerates unknown fields", () => {
  expect(parseDialogs({ dialogs: [{ _id: "a", brand_new_field: { x: 1 } }], extra: true })).toHaveLength(1);
});

const rawMsg = (over: Record<string, unknown> = {}) => ({
  _id: "m1", from: "u2", date: 1700000000000, message: "<b>hi</b>", msg_index: 7, ...over,
});

test("parseHistory normalizes a message", () => {
  const [m] = parseHistory([rawMsg({ reply_to: { _id: "m0" }, mention: ["u9", { _id: "u8" }], edited: 1700000001 })], dm, "u1");
  expect(m).toEqual({
    id: "m1", chatId: "d1", chatName: "Ata", index: 7, from: "u2", fromName: "Ata", fromMe: false,
    date: 1700000000000, text: "hi", replyTo: "m0", mentions: ["u9", "u8"], edited: true, deleted: false, service: false,
  });
});

test("parseHistory marks my own messages and names me", () => {
  const [m] = parseHistory([rawMsg({ from: "u1" })], dm, "u1");
  expect(m!.fromMe).toBe(true);
  expect(m!.fromName).toBe("me");
});

test("parseHistory leaves fromName unset in groups and when my id is unknown", () => {
  expect(parseHistory([rawMsg()], group, "u1")[0]!.fromName).toBeUndefined();
  expect(parseHistory([rawMsg()], dm)[0]!.fromMe).toBe(false);
});

test("parseHistory accepts a from object and a wrapped list", () => {
  const [m] = parseHistory({ messages: [rawMsg({ from: { _id: "u2", name: "x" } })] }, group);
  expect(m!.from).toBe("u2");
});

test("parseHistory handles deleted messages with no body", () => {
  const [m] = parseHistory([rawMsg({ message: null, deleted: true })], dm);
  expect(m!.deleted).toBe(true);
  expect(m!.text).toBe("");
});

test("parseHistory of an empty page is empty", () => {
  expect(parseHistory([], dm)).toEqual([]);
});

test("parseHistory raises SchemaError for a message missing msg_index", () => {
  expect(() => parseHistory([{ _id: "m", from: "u", date: 1 }], dm)).toThrow(/chat\/getHistory/);
});

test("parseDialogs accepts a string peer_user as peerId and falls back to the id for the name", () => {
  const [c] = parseDialogs({ dialogs: [{ _id: "d9", is_group: false, peer_user: "u7" }] });
  expect(c!.peerId).toBe("u7");
  expect(c!.name).toBe("d9");
});

test("parseHistory flags service messages", () => {
  const msgs = parseHistory([rawMsg({ _: "messageService" }), rawMsg({ _id: "m2", _: "message" }), rawMsg({ _id: "m3" })], dm);
  expect(msgs.map((m) => m.service)).toEqual([true, false, false]);
});

test("parseHistory describes attachments without downloading anything", () => {
  const [photo, doc, task, mention, none] = parseHistory(
    [
      rawMsg({ message: "", media: { _: "messageMediaPhoto", photo: { name: "a.jpg" } } }),
      rawMsg({ _id: "m2", message: "", media: { _: "messageMediaDocument", document: { name: "report.pdf", size: 1234 } } }),
      rawMsg({ _id: "m3", message: "", media: { _: "messageMediaTaskSchedule", task: { title: "Fix login" } } }),
      rawMsg({ _id: "m4", message: "", media: { _: "messageMediaMentionInChat", dialog: "d" } }),
      rawMsg({ _id: "m5", media: null }),
    ],
    dm,
  );
  expect(photo!.attachment).toEqual({ kind: "photo", name: "a.jpg" });
  expect(doc!.attachment).toEqual({ kind: "document", name: "report.pdf", size: 1234 });
  expect(task!.attachment).toEqual({ kind: "taskSchedule", name: "Fix login" });
  expect(mention!.attachment).toEqual({ kind: "mentionInChat" });
  expect(none!.attachment).toBeUndefined();
});

test("describeMessage shows text, or a bracketed attachment when there is no text", () => {
  const [a, b, c] = parseHistory(
    [
      rawMsg({ message: "hello" }),
      rawMsg({ _id: "m2", message: "", media: { _: "messageMediaDocument", document: { name: "r.pdf" } } }),
      rawMsg({ _id: "m3", message: "", media: { _: "messageMediaAudio", audio: {} } }),
    ],
    dm,
  );
  expect(describeMessage(a!)).toBe("hello");
  expect(describeMessage(b!)).toBe("[document: r.pdf]");
  expect(describeMessage(c!)).toBe("[audio]");
});
