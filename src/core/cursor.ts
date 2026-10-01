import { readFile } from "node:fs/promises";
import { writePrivateJson } from "./stores";

export interface CursorEntry {
  index: number;
  count: number;
  lastDate: number;
}

export class CursorStore {
  private constructor(private readonly path: string, private data: Record<string, CursorEntry>) {}

  static async open(path: string): Promise<CursorStore> {
    try {
      const v = JSON.parse(await readFile(path, "utf8"));
      return new CursorStore(path, v && typeof v === "object" ? (v as Record<string, CursorEntry>) : {});
    } catch {
      return new CursorStore(path, {});
    }
  }

  get(chatId: string): CursorEntry | undefined {
    return this.data[chatId];
  }

  set(chatId: string, e: CursorEntry): void {
    this.data[chatId] = e;
  }

  save(): Promise<void> {
    return writePrivateJson(this.path, this.data);
  }
}
