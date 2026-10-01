import { randomBytes } from "node:crypto";
import type { Poster } from "./client";
import { ConfigError, SendDisabled } from "./errors";

export interface SendOptions {
  allowSend: boolean;
  userId?: string;
  now?: () => number;
  randomHex?: (bytes: number) => string;
}

export async function sendMessage(client: Poster, chatId: string, text: string, o: SendOptions): Promise<void> {
  if (!o.allowSend) throw new SendDisabled();
  if (!o.userId) throw new ConfigError("MIZITO_USER_ID is required to send messages");
  if (!text.trim()) throw new ConfigError("Cannot send an empty message");
  const hex = o.randomHex ?? ((n: number) => randomBytes(n).toString("hex"));
  await client.post("/api/chat/send", {
    _: "message",
    _id: hex(12),
    dialog: chatId,
    message: text,
    from: o.userId,
    date: (o.now ?? Date.now)(),
    reply_to: null,
    mention: [],
    randomId: hex(8),
  });
}
