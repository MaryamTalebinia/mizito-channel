#!/usr/bin/env bun
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { login as doLogin } from "../core/auth";
import { ChatService } from "../core/chats";
import { MizitoClient } from "../core/client";
import { loadConfig } from "../core/config";
import { CursorStore } from "../core/cursor";
import { sendMessage } from "../core/send";
import { FileCredentialStore, FileNameCache, FileTokenStore, loadCredentials } from "../core/stores";
import { Watcher } from "../core/watcher";
import { createMcpServer, startPush } from "../mcp/server";
import { runCli } from "./run";

async function readLine(prompt: string, hidden: boolean): Promise<string> {
  process.stderr.write(prompt);
  const stdin = process.stdin;
  if (hidden && stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let line = "";
  return new Promise((resolve) => {
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          if (hidden && stdin.isTTY) stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          return resolve(line);
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") line = line.slice(0, -1);
        else line += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<number> {
  const config = loadConfig(process.env);
  const credStore = new FileCredentialStore(join(config.home, "credentials.json"));
  const tokenStore = new FileTokenStore(join(config.home, "session.json"));

  // A cached token works without credentials; credentials are only needed if a
  // login happens. Missing credentials surface as the original AuthError then.
  let credError: unknown;
  const credentials = await loadCredentials(process.env, credStore).catch((e) => {
    credError = e;
    return { username: "", password: "" };
  });
  const client = new MizitoClient({
    baseUrl: config.baseUrl,
    credentials,
    token: await tokenStore.get(),
    onToken: (t) => tokenStore.set(t),
    fetch: (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (credError && String(url).endsWith("/capi/session/create")) throw credError;
      return fetch(url, init);
    }) as typeof fetch,
  });

  const names = await FileNameCache.open(join(config.home, "names.json"));
  const chats = new ChatService(client, { userId: config.userId, names });
  const makeWatcher = async () =>
    new Watcher({ chats, cursors: await CursorStore.open(join(config.home, "cursors.json")) });
  const watcher = await makeWatcher();
  const send = (chatId: string, text: string) =>
    sendMessage(client, chatId, text, { allowSend: config.allowSend, userId: config.userId });

  const mcpDeps = {
    chats,
    watcher,
    send,
    allowSend: config.allowSend,
    push: process.env.MIZITO_PUSH === "1",
    pollIntervalMs: config.pollIntervalMs,
  };

  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());

  return runCli(process.argv.slice(2), {
    chats,
    watcher: () => watcher,
    send,
    pollIntervalMs: config.pollIntervalMs,
    login: async () => {
      const username = process.env.MIZITO_USERNAME ?? (await readLine("Mizito username: ", false));
      const password = process.env.MIZITO_PASSWORD ?? (await readLine("Mizito password: ", true));
      const token = await doLogin(fetch, config.baseUrl, { username, password });
      await credStore.set({ username, password });
      await tokenStore.set(token);
      console.error(`Logged in. Credentials saved to ${config.home} (mode 0600).`);
    },
    startMcp: async () => {
      const server = createMcpServer(mcpDeps);
      await server.connect(new StdioServerTransport());
      if (mcpDeps.push) await startPush(server, mcpDeps, ac.signal);
      await new Promise<void>((r) => ac.signal.addEventListener("abort", () => r()));
    },
  }, { out: (s) => console.log(s), err: (s) => console.error(s), signal: ac.signal });
}

process.exit(await main());
