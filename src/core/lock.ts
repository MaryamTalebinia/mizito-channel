import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConfigError } from "./errors";

const defaultIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export interface PidLockOptions {
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

// One watcher per state directory: two watchers would share cursors.json and deliver messages twice.
export class PidLock {
  private held = false;

  constructor(private readonly path: string, private readonly o: PidLockOptions = {}) {}

  async acquire(): Promise<void> {
    if (this.held) return;
    const pid = this.o.pid ?? process.pid;
    const isAlive = this.o.isAlive ?? defaultIsAlive;
    mkdirSync(dirname(this.path), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(this.path, String(pid), { flag: "wx", mode: 0o600 });
        this.held = true;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      let other = NaN;
      try {
        other = Number(readFileSync(this.path, "utf8").trim());
      } catch {
        continue; // released between our write and read; retry
      }
      if (other === pid) {
        this.held = true;
        return;
      }
      if (Number.isInteger(other) && other > 0 && isAlive(other)) {
        throw new ConfigError(
          `Another mizito watcher is already running (pid ${other}). Only one watcher can use this state directory.`,
        );
      }
      try {
        unlinkSync(this.path); // stale lock from a dead process
      } catch {}
    }
    throw new ConfigError("Could not acquire the watcher lock");
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      unlinkSync(this.path);
    } catch {}
  }
}
