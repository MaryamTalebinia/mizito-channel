import { z } from "zod";
import { SchemaError } from "./errors";
import { htmlToText } from "./text";

export interface Chat {
  id: string;
  name: string;
  isGroup: boolean;
  peerId?: string;
  unread: number;
  messagesCount: number;
  lastMessageDate?: number;
}

export interface Message {
  id: string;
  chatId: string;
  chatName: string;
  index: number;
  from: string;
  fromName?: string;
  fromMe: boolean;
  date: number;
  text: string;
  replyTo?: string;
  mentions: string[];
  edited: boolean;
  deleted: boolean;
  service: boolean;
}

function toMillis(v: number | string): number {
  if (typeof v === "number") return v;
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

const Millis = z.union([z.number(), z.string()]).transform(toMillis);
const Ref = z.union([z.string(), z.object({ _id: z.string() }).loose()]);

const RawDialog = z
  .object({
    _id: z.string(),
    is_group: z.boolean().optional(),
    unread_count: z.number().optional(),
    messages_count: z.number().optional(),
    last_message_date: Millis.optional(),
    title: z.string().optional(),
    name: z.string().optional(),
    peer_user: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  })
  .loose();
const DialogsResponse = z.object({ dialogs: z.array(RawDialog) }).loose();

const RawMessage = z
  .object({
    _id: z.string(),
    _: z.string().optional(),
    from: Ref,
    date: Millis,
    message: z.string().nullish(),
    msg_index: z.number(),
    reply_to: z.unknown().optional(),
    mention: z.array(z.unknown()).optional(),
    edited: z.unknown().optional(),
    deleted: z.unknown().optional(),
  })
  .loose();
const HistoryResponse = z.union([
  z.array(RawMessage),
  z.object({ messages: z.array(RawMessage) }).loose().transform((o) => o.messages),
]);

function parse<T extends z.ZodType>(endpoint: string, schema: T, data: unknown): z.output<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new SchemaError(endpoint, issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "invalid");
  }
  return r.data;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function refId(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") return str((v as { _id?: unknown })._id);
  return undefined;
}

function dialogName(d: z.output<typeof RawDialog>): string {
  const peer = typeof d.peer_user === "object" ? d.peer_user : undefined;
  const peerName = peer
    ? str(peer.name) ?? (([str(peer.first_name), str(peer.last_name)].filter(Boolean).join(" ")) || undefined)
    : undefined;
  return d.title ?? d.name ?? peerName ?? d._id;
}

function peerIdOf(v: unknown): string | undefined {
  return typeof v === "string" ? v : v && typeof v === "object" ? str((v as { _id?: unknown })._id) : undefined;
}

export function parseDialogs(data: unknown): Chat[] {
  return parse("chat/getDialogs", DialogsResponse, data).dialogs.map((d) => ({
    id: d._id,
    name: dialogName(d),
    isGroup: d.is_group ?? false,
    peerId: peerIdOf(d.peer_user),
    unread: d.unread_count ?? 0,
    messagesCount: d.messages_count ?? 0,
    lastMessageDate: d.last_message_date,
  }));
}

export function parseHistory(
  data: unknown,
  chat: Pick<Chat, "id" | "name" | "isGroup">,
  userId?: string,
): Message[] {
  return parse("chat/getHistory", HistoryResponse, data).map((m) => {
    const from = refId(m.from) ?? "";
    const fromMe = userId !== undefined && from === userId;
    const replyTo = refId(m.reply_to);
    return {
      id: m._id,
      chatId: chat.id,
      chatName: chat.name,
      index: m.msg_index,
      from,
      fromName: fromMe ? "me" : chat.isGroup ? undefined : chat.name,
      fromMe,
      date: m.date,
      text: htmlToText(m.message ?? ""),
      ...(replyTo ? { replyTo } : {}),
      mentions: (m.mention ?? []).map(refId).filter((x): x is string => x !== undefined),
      edited: Boolean(m.edited),
      deleted: Boolean(m.deleted),
      service: m._ === "messageService",
    };
  });
}
