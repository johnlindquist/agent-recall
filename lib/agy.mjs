// lib/agy.mjs — Antigravity (agy) conversation-DB snapshotter.
// Standalone; NOT wired into the archiver yet (ships behind the wal-canary gate).
//
// Snapshot primitive: node:sqlite's module-level backup() — the SQLite Online
// Backup API. Verified on Node v25.2.1: backup(srcDb, destPath) accepts a
// READ-ONLY DatabaseSync source, returns a Promise, copies WAL-resident pages
// into the destination, and leaves the source .db/-wal byte-for-byte untouched.
// `VACUUM INTO` from a readonly connection also works (it only writes the
// target), but backup() is the mandated Online Backup API, so it is the
// primitive used. Both functions here are async solely because backup() is
// Promise-based.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync, backup } from "node:sqlite";
import { HOME, ARCHIVE, STATE } from "./paths.mjs";

export const AGY_SRC = path.join(HOME, ".gemini/antigravity-cli/conversations");

// SQLITE_BUSY detection. Two shapes observed on Node v25.2.1:
// - normal statement paths: errcode 5 / "database is locked"
// - backup() against a locked source: node:sqlite loses the real code and
//   rejects with {code:'ERR_SQLITE_ERROR', errcode:0, message:'not an error'}
//   (verified: retrying after the lock clears succeeds; corrupt files reject
//   distinctly with errcode 26 "file is not a database"). Treat that
//   degenerate shape as busy so skip-on-busy actually fires.
const isBusy = (e) =>
  e?.errcode === 5 ||
  /SQLITE_BUSY|database is locked/i.test(e?.message ?? "") ||
  (e?.code === "ERR_SQLITE_ERROR" && e?.errcode === 0 && /not an error/.test(e?.message ?? ""));

// One snapshot via the Online Backup API from a read-only source connection.
// Never writes or checkpoints the source.
async function snapshotDb(srcPath, destPath) {
  const src = new DatabaseSync(srcPath, { readOnly: true });
  try {
    await backup(src, destPath);
  } finally {
    src.close();
  }
}

// 3 attempts max on SQLITE_BUSY, delays 0 / 500ms / 2s. Never blocks past that.
async function snapshotWithRetry(srcPath, destPath) {
  for (let attempt = 0; ; attempt++) {
    try {
      await snapshotDb(srcPath, destPath);
      return;
    } catch (e) {
      fs.rmSync(destPath, { force: true }); // never leave a partial file
      if (!isBusy(e)) throw e;
      if (attempt >= 2) {
        e.busy = true;
        throw e;
      }
      await sleep([500, 2000][attempt]);
    }
  }
}

// PRAGMA integrity_check on the SNAPSHOT via a fresh connection (never the source).
function integrityCheck(p) {
  const c = new DatabaseSync(p, { readOnly: true });
  try {
    const rows = c.prepare("PRAGMA integrity_check").all();
    if (rows.length === 1 && rows[0].integrity_check === "ok") return "ok";
    return rows.map((r) => r.integrity_check).join("; ") || "no result";
  } finally {
    c.close();
  }
}

function hashFile(p) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.alloc(1 << 22);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0)
      h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

// Change detection key: main db + wal sidecar {size, mtimeMs}.
function statKey(dbPath) {
  const s = fs.statSync(dbPath);
  let walSize = 0;
  let walMtimeMs = 0;
  try {
    const w = fs.statSync(dbPath + "-wal");
    walSize = w.size;
    walMtimeMs = w.mtimeMs;
  } catch {}
  return { size: s.size, mtimeMs: s.mtimeMs, walSize, walMtimeMs };
}

function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Gate item 1: prove the snapshot primitive captures WAL-resident rows without
// touching the source. Honest — every claim is checked, not assumed.
export async function walCanary() {
  const details = [];
  let pass = true;
  const check = (ok, msg) => {
    details.push(`${ok ? "ok" : "FAIL"}: ${msg}`);
    if (!ok) pass = false;
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-canary-"));
  let db;
  try {
    const src = path.join(dir, "canary.db");
    db = new DatabaseSync(src);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    const ins = db.prepare("INSERT INTO t(v) VALUES (?)");
    for (let i = 0; i < 100; i++) ins.run(`row-${i}`);
    // Connection stays open, no checkpoint: rows live in canary.db-wal.
    const dbBefore = fs.statSync(src).size;
    const walBefore = fs.statSync(src + "-wal").size;
    check(walBefore > 0, `source -wal has content pre-snapshot (${walBefore} bytes)`);

    const snap = path.join(dir, "snap.db");
    await snapshotDb(src, snap);

    const c = new DatabaseSync(snap, { readOnly: true });
    const n = c.prepare("SELECT count(*) AS c FROM t").get().c;
    const last = c.prepare("SELECT v FROM t WHERE id = 100").get();
    check(
      n === 100 && last?.v === "row-99",
      `snapshot contains all 100 rows incl. WAL-resident (got ${n})`
    );
    c.close();
    const verdict = integrityCheck(snap);
    check(verdict === "ok", `snapshot integrity_check == '${verdict}'`);
    check(
      fs.statSync(src).size === dbBefore &&
        fs.statSync(src + "-wal").size === walBefore,
      "source db + wal byte sizes unchanged"
    );
    const ro = new DatabaseSync(src, { readOnly: true });
    const stillReadable = ro.prepare("SELECT count(*) AS c FROM t").get().c === 100;
    ro.close();
    check(stillReadable, "source still readable");
    ins.run("post-snapshot");
    check(
      db.prepare("SELECT count(*) AS c FROM t").get().c === 101,
      "source still writable"
    );
  } catch (e) {
    pass = false;
    details.push(`FAIL: ${e.message}`);
  } finally {
    try {
      db?.close();
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { pass, details };
}

// Snapshot every changed conversation db into immutable generations:
// outDir/<uuid>/gNNNN.db (files 0600, dirs 0700). State keyed by uuid in
// stateFile: {size, mtimeMs, walSize, walMtimeMs, gen, hash}.
export async function snapshotAll({
  budgetMs = 60000,
  maxBytes = 2 * 1024 ** 3,
  srcDir = AGY_SRC,
  outDir = path.join(ARCHIVE, "agy"),
  stateFile = path.join(STATE, "agy-manifest.json"),
} = {}) {
  const t0 = Date.now();
  const report = {
    snapshotted: 0,
    deduped: 0,
    skippedBusy: 0,
    skippedUnchanged: 0,
    errors: [],
    bytes: 0,
  };
  let names;
  try {
    // -wal/-shm sidecars end in ".db-wal"/".db-shm", so endsWith(".db")
    // already excludes them as standalone entries.
    names = fs.readdirSync(srcDir).filter((n) => n.endsWith(".db"));
  } catch {
    return report; // no source dir — agy not installed; nothing to do
  }
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {}
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });

  for (const name of names.sort()) {
    if (Date.now() - t0 > budgetMs) break; // time budget
    const uuid = name.slice(0, -3);
    const src = path.join(srcDir, name);
    let st;
    try {
      st = statKey(src);
    } catch (e) {
      report.errors.push(`${name}: ${e.message}`);
      continue;
    }
    const prev = state[uuid];
    if (
      prev &&
      prev.size === st.size &&
      prev.mtimeMs === st.mtimeMs &&
      prev.walSize === st.walSize &&
      prev.walMtimeMs === st.walMtimeMs
    ) {
      report.skippedUnchanged++;
      continue;
    }
    if (report.bytes + st.size + st.walSize > maxBytes) break; // byte cap

    const dir = path.join(outDir, uuid);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const tmp = path.join(dir, `.tmp-${process.pid}`);
    try {
      try {
        await snapshotWithRetry(src, tmp);
      } catch (e) {
        if (e.busy) {
          report.skippedBusy++;
          continue;
        }
        throw e;
      }
      const verdict = integrityCheck(tmp);
      if (verdict !== "ok") throw new Error(`integrity_check: ${verdict}`);
      const hash = hashFile(tmp);
      if (prev && prev.hash === hash) {
        report.deduped++; // content unchanged — refresh stats, keep generation
        state[uuid] = { ...prev, ...st };
      } else {
        const gen = (prev?.gen || 0) + 1;
        const dest = path.join(dir, `g${String(gen).padStart(4, "0")}.db`);
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, dest); // atomic; generations are immutable
        report.snapshotted++;
        report.bytes += fs.statSync(dest).size;
        state[uuid] = { ...st, gen, hash };
      }
      writeFileAtomic(stateFile, JSON.stringify(state, null, 2));
    } catch (e) {
      report.errors.push(`${name}: ${e.message}`);
    } finally {
      fs.rmSync(tmp, { force: true }); // never leave partial output
    }
  }
  return report;
}
