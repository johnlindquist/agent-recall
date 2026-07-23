// Cross-process synchronous owner-token lock for short local critical sections.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const waitCell = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(waitCell, 0, 0, ms);
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
};

export function withOwnerLock(
  lockDir,
  fn,
  { timeoutMs = 30_000, staleMs = 30_000 } = {},
) {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(16).toString("hex");
  const ownerFile = path.join(lockDir, "owner.json");
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      try {
        fs.writeFileSync(ownerFile, JSON.stringify({
          pid: process.pid,
          token,
          startedAt: new Date().toISOString(),
        }) + "\n", { flag: "wx", mode: 0o600 });
      } catch (error) {
        try { fs.rmdirSync(lockDir); } catch {}
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")); } catch {}
      let age = 0;
      try { age = Date.now() - fs.statSync(lockDir).mtimeMs; } catch { continue; }
      const ownerLive = Number.isInteger(owner?.pid) && pidAlive(owner.pid);
      if (!ownerLive && age >= staleMs) {
        const tomb = `${lockDir}.stale-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
        try {
          fs.renameSync(lockDir, tomb);
          fs.rmSync(tomb, { recursive: true, force: true });
          continue;
        } catch {}
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for lock: ${path.basename(lockDir)}`);
      sleep(10);
    }
  }

  try {
    return fn();
  } finally {
    try {
      const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
      if (owner.token === token) {
        const tomb = `${lockDir}.released-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
        fs.renameSync(lockDir, tomb);
        fs.rmSync(tomb, { recursive: true, force: true });
      }
    } catch {}
  }
}
