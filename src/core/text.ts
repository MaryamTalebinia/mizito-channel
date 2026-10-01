const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/(?:<\/?(?:p|div)\b[^>]*>)+/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|nbsp|#39|#x[0-9a-f]+|#\d+);/gi, (m) => {
      const named = ENTITIES[m.toLowerCase()];
      if (named !== undefined) return named;
      const cp = m[2]!.toLowerCase() === "x" ? parseInt(m.slice(3, -1), 16) : parseInt(m.slice(2, -1), 10);
      const ok = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
      return ok ? String.fromCodePoint(cp) : m;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
