import { parseArgs } from "node:util";
import type { ChatService } from "../core/chats";
import { type Batch, nextBatch } from "../core/watcher";
import { Backoff } from "../core/backoff";
import { MizitoError, NetworkError, RateLimited } from "../core/errors";
import { describeMessage, type Message } from "../core/models";

export interface CliDeps {
  chats: Pick<ChatService, "listChats" | "resolveChat" | "readMessages" | "search">;
  watcher: () => { poll(): Promise<Message[]>; pollBatch?(): Promise<Batch> };
  send: (chatId: string, text: string) => Promise<void>;
  login: () => Promise<void>;
  startMcp: () => Promise<void>;
  pollIntervalMs: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CliIo {
  out(s: string): void;
  err(s: string): void;
  signal?: AbortSignal;
}

class Usage extends Error {}

const EXIT: Record<string, number> = { AUTH: 2, SEND_DISABLED: 3 };

const fmt = (m: Message) =>
  `[${new Date(m.date).toISOString()}] ${m.chatName} / ${m.sender}: ${describeMessage(m)}`;

export async function runCli(argv: string[], deps: CliDeps, io: CliIo): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { json: { type: "boolean" }, limit: { type: "string" } },
    });
    const [cmd, ...rest] = positionals;
    const json = values.json === true;
    const need = (n: number, usage: string) => {
      if (rest.length < n) throw new Usage(`usage: mizito ${usage}`);
    };
    const printMessages = (msgs: Message[]) =>
      json ? io.out(JSON.stringify(msgs, null, 2)) : [...msgs].reverse().forEach((m) => io.out(fmt(m)));

    switch (cmd) {
      case "chats": {
        const chats = await deps.chats.listChats();
        if (json) io.out(JSON.stringify(chats, null, 2));
        else for (const c of chats) io.out(`${c.id}\t${c.isGroup ? "group" : "dm"}\t${c.unread}\t${c.name}`);
        return 0;
      }
      case "read": {
        need(1, "read <chat> [--limit N] [--json]");
        const limit = values.limit !== undefined ? Number(values.limit) : undefined;
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
          throw new Usage("--limit must be a positive whole number");
        }
        printMessages(await deps.chats.readMessages(rest[0]!, limit ? { limit } : {}));
        return 0;
      }
      case "search": {
        need(2, "search <chat> <query> [--json]");
        printMessages(await deps.chats.search(rest[0]!, rest.slice(1).join(" ")));
        return 0;
      }
      case "watch": {
        const watcher = deps.watcher();
        const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        const backoff = new Backoff({ baseMs: deps.pollIntervalMs });
        while (!io.signal?.aborted) {
          let delay: number;
          try {
            const batch = await nextBatch(watcher);
            for (const m of batch.messages) io.out(json ? JSON.stringify(m) : fmt(m));
            await batch.commit();
            delay = backoff.next(batch.messages.length > 0 ? "messages" : "idle");
          } catch (e) {
            if (!(e instanceof RateLimited || e instanceof NetworkError)) throw e;
            io.err(`${e.message} (retrying)`);
            delay = backoff.next(e instanceof RateLimited ? "rateLimited" : "error");
          }
          if (io.signal?.aborted) break;
          await sleep(delay);
        }
        return 0;
      }
      case "send": {
        need(2, "send <chat> <text>");
        const chat = await deps.chats.resolveChat(rest[0]!, { exact: true });
        await deps.send(chat.id, rest.slice(1).join(" "));
        return 0;
      }
      case "login":
        await deps.login();
        return 0;
      case "mcp":
        await deps.startMcp();
        return 0;
      default:
        throw new Usage("usage: mizito <chats|read|search|watch|send|login|mcp> ...");
    }
  } catch (e) {
    if (e instanceof Usage) {
      io.err(e.message);
      return 64;
    }
    io.err(e instanceof Error ? e.message : String(e));
    return e instanceof MizitoError ? (EXIT[e.code] ?? 1) : 1;
  }
}
