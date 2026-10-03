import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, SendDisabled } from "../src/core/errors";
import type { Poster, Uploader } from "../src/core/client";
import { MAX_FILE_BYTES, MAX_FILES, mimeTypeFor, sendFiles, sendMessage } from "../src/core/send";

function recorder() {
  const calls: { path: string; body: any }[] = [];
  const poster: Poster = { async post(path, body) { calls.push({ path, body }); return {}; } };
  return { poster, calls };
}

const deterministic = {
  now: () => 1234,
  randomHex: (n: number) => "ab".repeat(n),
  localId: () => 123,
  randomId: () => 456,
};

test("refuses when sending is disabled and makes no request", async () => {
  const r = recorder();
  await expect(sendMessage(r.poster, "d1", "hi", { allowSend: false, userId: "u1" })).rejects.toBeInstanceOf(SendDisabled);
  expect(r.calls).toHaveLength(0);
});

test("refuses without a user id (needed for the from field)", async () => {
  const r = recorder();
  await expect(sendMessage(r.poster, "d1", "hi", { allowSend: true })).rejects.toBeInstanceOf(ConfigError);
  expect(r.calls).toHaveLength(0);
});

test("posts the web client's message shape", async () => {
  const r = recorder();
  await sendMessage(r.poster, "d1", "hello", { allowSend: true, userId: "u1", ...deterministic });
  expect(r.calls).toEqual([
    {
      path: "/api/chat/send",
      body: {
        _: "message", _id: "ab".repeat(12), dialog: "d1", message: "hello", from: "u1",
        date: 1234, reply_to: null, mention: [], randomId: "ab".repeat(8),
      },
    },
  ]);
});

test("preserves plain text and newlines without HTML formatting", async () => {
  const r = recorder();
  await sendMessage(r.poster, "d1", "a <b> & c\nd", { allowSend: true, userId: "u1", ...deterministic });
  expect(r.calls[0]!.body.message).toBe("a <b> & c\nd");
});

test("rejects empty text", async () => {
  const r = recorder();
  await expect(sendMessage(r.poster, "d1", "   ", { allowSend: true, userId: "u1" })).rejects.toThrow(/empty/i);
  expect(r.calls).toHaveLength(0);
});

async function fileFixture() {
  const dir = await mkdtemp(join(tmpdir(), "mizito-send-"));
  const pdf = join(dir, "one.pdf");
  const pptx = join(dir, "two.pptx");
  await writeFile(pdf, "pdf");
  await writeFile(pptx, "pptx");
  return { dir, pdf, pptx };
}

function fileRecorder() {
  const sent: { path: string; body: any }[] = [];
  const uploads: { name: string; type: string; text: string }[] = [];
  const client: Poster & Uploader = {
    async post(path, body) { sent.push({ path, body }); return {}; },
    async upload(name, data, type) {
      uploads.push({ name, type, text: await data.text() });
      return { _: "messageMediaDocument", document: { name } };
    },
  };
  return { client, sent, uploads };
}

test("detects common MIME types including PDF and PPTX", () => {
  expect(mimeTypeFor("REPORT.PDF")).toBe("application/pdf");
  expect(mimeTypeFor("slides.pptx")).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
  expect(mimeTypeFor("unknown.bin2")).toBe("application/octet-stream");
});

test("uploads each file and sends one exact-shape message per file with caption on the last", async () => {
  const { pdf, pptx } = await fileFixture();
  const r = fileRecorder();
  await sendFiles(r.client, "d1", [pdf, pptx], "caption", { allowSend: true, userId: "u1", ...deterministic });
  expect(r.uploads).toEqual([
    { name: "one.pdf", type: "application/pdf", text: "pdf" },
    { name: "two.pptx", type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", text: "pptx" },
  ]);
  expect(r.sent).toHaveLength(2);
  expect(r.sent.map((c) => c.body.message)).toEqual(["", "caption"]);
  expect(r.sent[0]!.body).toEqual({
    _: "message", _id: 123, local: 123, dialog: "d1", out: true, message: "",
    media: { _: "messageMediaDocument", document: { name: "one.pdf" }, view_as_entity: true, randomId: 456 },
    from: "u1", date: 1234, reply_to: null, mention: [], seen_count: 1, randomId: 456, pending: true,
  });
});

test("validates every path before uploading and rejects invalid file sets", async () => {
  const { dir, pdf } = await fileFixture();
  const r = fileRecorder();
  const opts = { allowSend: true, userId: "u1" };
  await expect(sendFiles(r.client, "d", [], undefined, opts)).rejects.toThrow(/at least one/i);
  await expect(sendFiles(r.client, "d", Array(MAX_FILES + 1).fill(pdf), undefined, opts)).rejects.toThrow(/at most/i);
  await expect(sendFiles(r.client, "d", [pdf, join(dir, "missing")], undefined, opts)).rejects.toThrow(/not found/i);
  await mkdir(join(dir, "folder"));
  await expect(sendFiles(r.client, "d", [join(dir, "folder")], undefined, opts)).rejects.toThrow(/regular file/i);
  const empty = join(dir, "empty.pdf");
  await writeFile(empty, "");
  await expect(sendFiles(r.client, "d", [empty], undefined, opts)).rejects.toThrow(/empty/i);
  const large = join(dir, "large.bin");
  await writeFile(large, new Uint8Array(MAX_FILE_BYTES + 1));
  await expect(sendFiles(r.client, "d", [large], undefined, opts)).rejects.toThrow(/20 MB/i);
  expect(r.uploads).toHaveLength(0);
  expect(r.sent).toHaveLength(0);
});

test("file sending obeys gates and rejects unexpected upload responses", async () => {
  const { pdf } = await fileFixture();
  const r = fileRecorder();
  await expect(sendFiles(r.client, "d", [pdf], undefined, { allowSend: false, userId: "u" })).rejects.toBeInstanceOf(SendDisabled);
  await expect(sendFiles(r.client, "d", [pdf], undefined, { allowSend: true })).rejects.toBeInstanceOf(ConfigError);
  const bad: Poster & Uploader = { post: r.client.post, upload: async () => null };
  await expect(sendFiles(bad, "d", [pdf], undefined, { allowSend: true, userId: "u" })).rejects.toThrow(/upload response/i);
  const malformed: Poster & Uploader = { post: r.client.post, upload: async () => ({ ok: true }) };
  await expect(sendFiles(malformed, "d", [pdf], undefined, { allowSend: true, userId: "u" })).rejects.toThrow(/media type/i);
});

test("uploads every file before sending any message", async () => {
  const { pdf, pptx } = await fileFixture();
  const sent: unknown[] = [];
  let uploads = 0;
  const client: Poster & Uploader = {
    async upload(name) {
      uploads++;
      if (name.endsWith(".pptx")) throw new Error("upload failed");
      return { _: "messageMediaDocument", document: { name } };
    },
    async post(_path, body) { sent.push(body); return {}; },
  };
  await expect(sendFiles(client, "d", [pdf, pptx], undefined, { allowSend: true, userId: "u" })).rejects.toThrow("upload failed");
  expect(uploads).toBe(2);
  expect(sent).toHaveLength(0);
});
