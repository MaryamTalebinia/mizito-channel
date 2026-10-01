import { expect, test } from "bun:test";
import { loadConfig } from "../src/core/config";

test("defaults", () => {
  const c = loadConfig({});
  expect(c.baseUrl).toBe("https://app.mizito.ir");
  expect(c.allowSend).toBe(false);
  expect(c.userId).toBeUndefined();
  expect(c.pollIntervalMs).toBe(3000);
  expect(c.home.endsWith("/mizito")).toBe(true);
});

test("MIZITO_HOME overrides the config directory", () => {
  expect(loadConfig({ MIZITO_HOME: "/tmp/x" }).home).toBe("/tmp/x");
});

test("only MIZITO_ALLOW_SEND=1 enables sending", () => {
  expect(loadConfig({ MIZITO_ALLOW_SEND: "1" }).allowSend).toBe(true);
  expect(loadConfig({ MIZITO_ALLOW_SEND: "true" }).allowSend).toBe(false);
  expect(loadConfig({ MIZITO_ALLOW_SEND: "0" }).allowSend).toBe(false);
});

test("poll interval ignores junk values", () => {
  expect(loadConfig({ MIZITO_POLL_MS: "500" }).pollIntervalMs).toBe(500);
  expect(loadConfig({ MIZITO_POLL_MS: "abc" }).pollIntervalMs).toBe(3000);
  expect(loadConfig({ MIZITO_POLL_MS: "-5" }).pollIntervalMs).toBe(3000);
});

test("MIZITO_PUSH_CHATS is a trimmed comma-separated list", () => {
  expect(loadConfig({}).pushChats).toEqual([]);
  expect(loadConfig({ MIZITO_PUSH_CHATS: " Team , 69aa ,," }).pushChats).toEqual(["Team", "69aa"]);
});
