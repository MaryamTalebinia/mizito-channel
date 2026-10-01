import { expect, test } from "bun:test";
import { AmbiguousChat, AuthError, MizitoError, SchemaError, SendDisabled } from "../src/core/errors";

test("typed errors extend MizitoError and carry a code", () => {
  const e = new AuthError("bad login");
  expect(e).toBeInstanceOf(MizitoError);
  expect(e).toBeInstanceOf(Error);
  expect(e.code).toBe("AUTH");
  expect(e.name).toBe("AuthError");
});

test("SchemaError names the endpoint", () => {
  expect(new SchemaError("chat/getHistory", "missing _id").message).toContain("chat/getHistory");
});

test("SendDisabled explains how to enable sending", () => {
  expect(new SendDisabled().message).toContain("MIZITO_ALLOW_SEND=1");
});

test("AmbiguousChat lists candidates in its message", () => {
  const e = new AmbiguousChat("ata", ["Ata A", "Ata B"]);
  expect(e.candidates).toEqual(["Ata A", "Ata B"]);
  expect(e.message).toContain("Ata A");
});
