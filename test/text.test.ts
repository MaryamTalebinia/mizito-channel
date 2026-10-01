import { expect, test } from "bun:test";
import { htmlToText } from "../src/core/text";

test("strips tags and keeps text", () => {
  expect(htmlToText("<b>hello</b> world")).toBe("hello world");
});

test("turns br and block ends into newlines", () => {
  expect(htmlToText("a<br>b<br/>c<p>d</p>e")).toBe("a\nb\nc\nd\ne");
});

test("decodes entities exactly once", () => {
  expect(htmlToText("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;&nbsp;f")).toBe(`a & b <c> "d" 'e' f`);
  expect(htmlToText("&amp;lt;")).toBe("&lt;");
});

test("preserves Persian text and emoji", () => {
  expect(htmlToText("<div>سلام 🫶 دنیا</div>")).toBe("سلام 🫶 دنیا");
});

test("collapses runs of blank lines and trims", () => {
  expect(htmlToText("  a<br><br><br><br>b  ")).toBe("a\n\nb");
});

test("empty input gives empty string", () => {
  expect(htmlToText("")).toBe("");
});

test("decodes numeric entities and leaves invalid ones alone", () => {
  expect(htmlToText("&#1587;&#x1F600;&#38;")).toBe("س😀&");
  expect(htmlToText("&#99999999; ok")).toBe("&#99999999; ok");
});
