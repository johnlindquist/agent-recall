// test/agy.test.mjs — walCanary gate + snapshotAll lifecycle on synthetic dbs.
// All I/O confined to mkdtemp dirs; the real ~/.gemini is never touched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { walCanary, snapshotAll } from "../lib/agy.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-"));

function makeDb(p, rows, { wal = false, keepOpen = false } = {}) {
  const db = new DatabaseSync(p);
  if (wal) db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
  const ins = db.prepare("INSERT INTO t(v) VALUES (?)");
  for (let i = 0; i < rows; i++) ins.run(`v${i}`);
  if (!keepOpen) {
    db.close();
    return null;
  }
  return db;
}

const countRows = (p) => {
  const c = new DatabaseSync(p, { readOnly: true });
  try {
    return c.prepare("SELECT count(*) AS c FROM t").get().c;
  } finally {
    c.close();
  }
};

test("walCanary passes", async () => {
  const r = await walCanary();
  assert.equal(r.pass, true, r.details.join("\n"));
  assert.ok(r.details.length >= 5);
});

test("snapshotAll: generations, skip-unchanged, dedupe, single new generation", async () => {
  const root = tmp();
  const srcDir = path.join(root, "src");
  fs.mkdirSync(srcDir);
  const outDir = path.join(root, "out");
  const stateFile = path.join(root, "state.json");
  const opts = { srcDir, outDir, stateFile };

  // aaaa: WAL mode, connection kept open (no checkpoint) so rows sit in -wal.
  const live = makeDb(path.join(srcDir, "aaaa.db"), 20, { wal: true, keepOpen: true });
  makeDb(path.join(srcDir, "bbbb.db"), 5);
  assert.ok(fs.statSync(path.join(srcDir, "aaaa.db-wal")).size > 0, "wal has content");

  // run 1: both snapshotted, integrity ok, WAL rows captured
  const r1 = await snapshotAll(opts);
  assert.equal(r1.snapshotted, 2);
  assert.deepEqual(r1.errors, []);
  assert.ok(r1.bytes > 0);
  for (const [uuid, n] of [["aaaa", 20], ["bbbb", 5]]) {
    const snap = path.join(outDir, uuid, "g0001.db");
    assert.ok(fs.existsSync(snap), `${snap} exists`);
    assert.equal(countRows(snap), n);
    const c = new DatabaseSync(snap, { readOnly: true });
    assert.equal(c.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    c.close();
  }

  // run 2: nothing changed
  const r2 = await snapshotAll(opts);
  assert.equal(r2.snapshotted, 0);
  assert.equal(r2.skippedUnchanged, 2);

  // touch mtime without changing content -> re-hashed, deduped, no new generation
  fs.utimesSync(path.join(srcDir, "bbbb.db"), new Date(), new Date(Date.now() + 5000));
  const r3 = await snapshotAll(opts);
  assert.equal(r3.deduped, 1);
  assert.equal(r3.snapshotted, 0);
  assert.ok(!fs.existsSync(path.join(outDir, "bbbb", "g0002.db")));

  // modify one db -> exactly one new generation, prior generation untouched
  live.exec("INSERT INTO t(v) VALUES ('new')");
  const r4 = await snapshotAll(opts);
  assert.equal(r4.snapshotted, 1);
  assert.equal(r4.skippedUnchanged, 1);
  const g2 = path.join(outDir, "aaaa", "g0002.db");
  assert.ok(fs.existsSync(g2));
  assert.equal(countRows(g2), 21);
  assert.equal(countRows(path.join(outDir, "aaaa", "g0001.db")), 20); // immutable
  assert.ok(!fs.existsSync(path.join(outDir, "bbbb", "g0002.db")));

  live.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("hostile: corrupt x.db -> recorded error, no crash, no partial output", async () => {
  const root = tmp();
  const srcDir = path.join(root, "src");
  fs.mkdirSync(srcDir);
  fs.writeFileSync(
    path.join(srcDir, "xxxx.db"),
    Buffer.from("this is definitely not a sqlite database, not even close")
  );
  const outDir = path.join(root, "out");
  const r = await snapshotAll({ srcDir, outDir, stateFile: path.join(root, "s.json") });
  assert.equal(r.snapshotted, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /xxxx/);
  const dir = path.join(outDir, "xxxx");
  const leftovers = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.deepEqual(leftovers, [], "no partial output files left");
  fs.rmSync(root, { recursive: true, force: true });
});

test("busy: exclusively locked db -> skippedBusy, no partial output, no infinite retry", async () => {
  const root = tmp();
  const srcDir = path.join(root, "src");
  fs.mkdirSync(srcDir);
  makeDb(path.join(srcDir, "cccc.db"), 3);
  const holder = new DatabaseSync(path.join(srcDir, "cccc.db"));
  holder.exec("BEGIN EXCLUSIVE");
  holder.exec("INSERT INTO t(v) VALUES ('locked')");
  const outDir = path.join(root, "out");
  const t0 = Date.now();
  const r = await snapshotAll({ srcDir, outDir, stateFile: path.join(root, "s.json") });
  holder.exec("ROLLBACK");
  holder.close();
  assert.equal(r.skippedBusy, 1);
  assert.equal(r.snapshotted, 0);
  assert.deepEqual(r.errors, []);
  assert.ok(Date.now() - t0 < 10000, "gave up after bounded retries");
  const dir = path.join(outDir, "cccc");
  const leftovers = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.deepEqual(leftovers, [], "no partial output files left");
  fs.rmSync(root, { recursive: true, force: true });
});

test("missing srcDir -> empty report, no throw", async () => {
  const root = tmp();
  const r = await snapshotAll({
    srcDir: path.join(root, "nope"),
    outDir: path.join(root, "out"),
    stateFile: path.join(root, "s.json"),
  });
  assert.deepEqual(r, {
    snapshotted: 0,
    deduped: 0,
    skippedBusy: 0,
    skippedUnchanged: 0,
    errors: [],
    bytes: 0,
  });
  fs.rmSync(root, { recursive: true, force: true });
});
