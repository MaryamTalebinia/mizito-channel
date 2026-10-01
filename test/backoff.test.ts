import { expect, test } from "bun:test";
import { Backoff } from "../src/core/backoff";

test("idle polls slow down gradually up to a cap", () => {
  const b = new Backoff({ baseMs: 1000 });
  expect([b.next("idle"), b.next("idle"), b.next("idle")]).toEqual([1500, 2250, 3375]);
  for (let i = 0; i < 20; i++) b.next("idle");
  expect(b.next("idle")).toBe(6000); // default cap is 6x base
});

test("a message resets the delay to the base", () => {
  const b = new Backoff({ baseMs: 1000 });
  b.next("idle"); b.next("idle");
  expect(b.next("messages")).toBe(1000);
  expect(b.next("idle")).toBe(1500);
});

test("rate limiting backs off hard, beyond the idle cap, but never past five minutes", () => {
  const b = new Backoff({ baseMs: 1000 });
  expect(b.next("rateLimited")).toBe(2000);
  expect(b.next("rateLimited")).toBe(4000);
  expect(b.next("rateLimited")).toBe(8000);
  for (let i = 0; i < 20; i++) b.next("rateLimited");
  expect(b.next("rateLimited")).toBe(300_000);
});

test("after rate limiting, calm polls come back down to the idle cap and then recover on messages", () => {
  const b = new Backoff({ baseMs: 1000 });
  for (let i = 0; i < 20; i++) b.next("rateLimited");
  expect(b.next("idle")).toBe(6000);
  expect(b.next("messages")).toBe(1000);
});

test("network errors double the delay up to the idle cap", () => {
  const b = new Backoff({ baseMs: 1000 });
  expect([b.next("error"), b.next("error"), b.next("error"), b.next("error")]).toEqual([2000, 4000, 6000, 6000]);
});
