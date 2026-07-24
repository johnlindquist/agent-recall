// test/coverage.test.mjs — lib/coverage.mjs in a mkdtemp RECALL_HOME with a
// synthetic manifest (one covered source, one 60-file uncovered source).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.RECALL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "recall-cov-test-"));

const { ARCHIVE, STATE, MANIFEST, SOURCES } = await import("../lib/paths.mjs");
const { dbOpen, indexAll, rebuild, recordGap } = await import("../lib/db.mjs");
const { manifest, coverage, banner } = await import("../lib/coverage.mjs");

const parsers = {
  parseRecord: function* (obj) { if (obj.ev) yield obj.ev; },
  fileContext: (obj, prev) => (obj.type === "session" ? { session: obj.id, cwd: obj.cwd } : prev),
  sessionOf: (obj, fp, rel) => obj.sessionId || (rel ? rel.split(path.sep)[0] : "") || path.basename(fp),
  tsOf: (obj) => obj.timestamp || "",
  projectOf: (obj, source, relDir, fileCwd) => fileCwd || obj.cwd || "",
  parseWholeJson: (buf) => { const v = JSON.parse(buf.toString("utf8")); return Array.isArray(v) ? v : [v]; },
  eventWeight: ({ opener }) => (opener ? 2.5 : 1),
};

const db = dbOpen();
const setMeta = (k, v) => db
  .prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v);
const touchIndex = () => setMeta("lastIndex", new Date().toISOString());
const setStats = (o) => setMeta("lastIndexStats", JSON.stringify(o));

const entry = (rel) => ({ rel, gens: ["g0001.jsonl"], size: 1, mtimeMs: 1, ino: 1, tail: "" });
function writeManifest({ ghost = true, at = new Date().toISOString(), storageSkipped = 0 } = {}) {
  const entries = { "srcA proj1/a.jsonl": entry("proj1/a.jsonl") };
  if (ghost) for (let i = 0; i < 60; i++) entries[`ghost f${i}.jsonl`] = entry(`f${i}.jsonl`);
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify({
    entries,
    lastRun: { at, seconds: 1, counts: { copied: 0, errors: 0, storageSkipped } },
  }));
}

test("manifest() is null before any archive run", () => {
  assert.equal(manifest(), null);
});

// index one real archived file for srcA so it counts as covered
const d = path.join(ARCHIVE, "srcA", "aaaa");
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(d, "relpath.txt"), "proj1/a.jsonl\n");
fs.writeFileSync(path.join(d, "g0001.jsonl"),
  '{"ev":{"role":"user","kind":"message","tool":"","text":"covered one"}}\n' +
  '{"ev":{"role":"assistant","kind":"message","tool":"","text":"covered two"}}\n');
rebuild(db);
await indexAll(db, { parsers });

test("uncovered source (60 archived, 0 indexed) is flagged with a gap line", () => {
  writeManifest();
  touchIndex();
  const cov = coverage(db);
  assert.equal(cov.archAgeMin, 0);
  assert.equal(cov.idxAgeMin, 0);
  assert.equal(cov.gapTotal, 0);
  assert.deepEqual(cov.perSource.srcA, { archivedFiles: 1, events: 2, sessions: 1, state: "ok" });
  assert.equal(cov.perSource.ghost.archivedFiles, 60);
  assert.equal(cov.perSource.ghost.events, 0);
  assert.equal(cov.perSource.ghost.state, "uncovered");
  assert.ok(cov.gaps.includes("SOURCE ghost: 60 files archived, 0 indexed (UNCOVERED — use --raw)"));
  assert.equal(cov.status, "degraded");
});

test("known SOURCES with nothing archived show up as empty or missing", () => {
  writeManifest();
  touchIndex();
  const cov = coverage(db);
  for (const src of Object.keys(SOURCES)) {
    assert.ok(cov.perSource[src], src);
    assert.equal(cov.perSource[src].archivedFiles, 0);
    assert.ok(["empty", "missing"].includes(cov.perSource[src].state), src);
  }
});

test("banner is compact and names the uncovered source", () => {
  writeManifest();
  touchIndex();
  const b = banner(coverage(db));
  const lines = b.split("\n");
  assert.ok(lines.length <= 2, b);
  assert.ok(lines[0].startsWith("recall: archive 0m · index 0m"), b);
  assert.match(lines[0], / sources ok:\d+ empty:\d+/);
  assert.ok(lines[0].includes("UNCOVERED: ghost 0/60"), b);
});

test("stale archive (>24h) degrades status with a gap", () => {
  writeManifest({ ghost: false, at: new Date(Date.now() - 30 * 3600 * 1000).toISOString() });
  touchIndex();
  const cov = coverage(db);
  assert.ok(cov.gaps.some((g) => g.includes("STALE")), JSON.stringify(cov.gaps));
  assert.equal(cov.status, "degraded");
  assert.match(banner(cov), /DEGRADED/);
});

test("run-local parseErrors and storageSkipped produce gap lines only", () => {
  writeManifest({ ghost: false, storageSkipped: 4 });
  touchIndex();
  setStats({ parseErrors: 5 });
  const cov = coverage(db);
  assert.ok(cov.gaps.some((g) => g.includes("5 unparsed lines")), JSON.stringify(cov.gaps));
  assert.ok(cov.gaps.some((g) => g.includes("4 files skipped")), JSON.stringify(cov.gaps));
  // run-local counters alone don't degrade; PERSISTENT gaps do (tested below)
  assert.equal(cov.status, "ok");
});

test("no index run yet degrades status", () => {
  writeManifest({ ghost: false });
  setStats({});
  db.prepare("DELETE FROM meta WHERE k='lastIndex'").run();
  const cov = coverage(db);
  assert.equal(cov.idxAgeMin, null);
  assert.equal(cov.status, "degraded");
  assert.ok(cov.gaps.includes("no index run yet"), JSON.stringify(cov.gaps));
  touchIndex();
});

test("index older than archive degrades; sub-second skew is tolerated (+1s slack)", () => {
  writeManifest({ ghost: false });
  setStats({});
  setMeta("lastIndex", new Date(Date.now() - 10_000).toISOString());
  let cov = coverage(db);
  assert.equal(cov.status, "degraded");
  assert.ok(cov.gaps.some((g) => g.includes("index older than archive")), JSON.stringify(cov.gaps));
  // within the 1s slack: still ok
  setMeta("lastIndex", new Date(Date.now() - 400).toISOString());
  cov = coverage(db);
  assert.equal(cov.status, "ok");
  touchIndex();
});

test("budgetHit in lastIndexStats degrades status", () => {
  writeManifest({ ghost: false });
  touchIndex();
  setStats({ budgetHit: true });
  const cov = coverage(db);
  assert.equal(cov.status, "degraded");
  assert.ok(cov.gaps.some((g) => g.includes("time budget")), JSON.stringify(cov.gaps));
});

test("fileErrors in lastIndexStats degrades status", () => {
  writeManifest({ ghost: false });
  touchIndex();
  setStats({ fileErrors: 2 });
  const cov = coverage(db);
  assert.equal(cov.status, "degraded");
  assert.ok(cov.gaps.some((g) => g.includes("2 file transactions failed")), JSON.stringify(cov.gaps));
});

test("persistent index gaps degrade status with a by-kind summary; banner shows total", () => {
  writeManifest({ ghost: false });
  touchIndex();
  setStats({ parseErrors: 0 });
  recordGap(db, { path: "/a/g0001.jsonl", line: 3, kind: "json-parse", detail: "bad" });
  recordGap(db, { path: "/a/g0002.jsonl", line: 9, kind: "json-parse", detail: "bad" });
  recordGap(db, { path: "/b/g0001.jsonl", line: 2, kind: "oversized-line", detail: "big" });
  const cov = coverage(db);
  assert.equal(cov.gapTotal, 3);
  assert.deepEqual(cov.gapsByKind, { "json-parse": 2, "oversized-line": 1 });
  assert.equal(cov.status, "degraded");
  assert.ok(cov.gaps.includes("3 permanent index gaps (json-parse 2 / oversized-line 1)"),
    JSON.stringify(cov.gaps));
  const b = banner(cov);
  assert.ok(b.split("\n")[0].includes("gaps:3"), b);
  assert.match(b, /DEGRADED/);
  db.exec("DELETE FROM index_gaps");
});

test("healthy manifest with no uncovered sources reports ok", () => {
  writeManifest({ ghost: false });
  touchIndex();
  setStats({ parseErrors: 0 });
  const cov = coverage(db);
  assert.equal(cov.status, "ok");
  assert.equal(cov.gapTotal, 0);
  assert.equal(cov.perSource.srcA.state, "ok");
  const b = banner(cov);
  assert.ok(!b.includes("UNCOVERED"), b);
  assert.ok(!b.includes("gaps:"), b);
});
