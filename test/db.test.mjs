// test/db.test.mjs — lib/db.mjs against a synthetic archive in a mkdtemp
// RECALL_HOME. Injects a mock parsers object so the suite passes without
// lib/parsers.mjs existing. Tests run serially and share one archive/db.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.RECALL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "recall-db-test-"));

const { ARCHIVE, PARSER_VERSION } = await import("../lib/paths.mjs");
const { dbOpen, indexAll, needsRebuild, rebuild, eventCounts, recordGap, gapCount, gapSummary } =
  await import("../lib/db.mjs");

// Minimal mock implementing the MODULES.md parsers contract. Records shaped
// {ev:{role,kind,tool,text}} pass through; {type:'session'} is a header.
const parsers = {
  parseRecord: function* (obj) { if (obj.ev) yield obj.ev; },
  fileContext: (obj, prev) => (obj.type === "session" ? { session: obj.id, cwd: obj.cwd } : prev),
  sessionOf: (obj, fp, rel) => obj.sessionId || (rel ? rel.split(path.sep)[0] : "") || path.basename(fp),
  tsOf: (obj) => obj.timestamp || "",
  projectOf: (obj, source, relDir, fileCwd) => fileCwd || obj.cwd || "",
  parseWholeJson: (buf) => { const v = JSON.parse(buf.toString("utf8")); return Array.isArray(v) ? v : [v]; },
  eventWeight: ({ role, kind, opener }) => (opener ? 2.5 : role === "user" ? 2 : kind === "tool" ? 0.7 : 1),
};

const J = JSON.stringify;
const ev = (role, kind, text, extra = {}) => J({ ev: { role, kind, tool: "", text }, ...extra });

function writeGen(source, key, rel, gen, content) {
  const d = path.join(ARCHIVE, source, key);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "relpath.txt"), rel + "\n");
  const fp = path.join(d, gen);
  fs.writeFileSync(fp, content);
  return fp;
}

const fileSha = (fp) => crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex");

const db = dbOpen();
const idx = (opts = {}) => indexAll(db, { parsers, ...opts });
const count = (sql, ...p) => db.prepare(sql).get(...p).c;

// --- fixtures: 2 sources, jsonl w/ header + malformed line, pretty *.json,
// and a jsonl ending in a trailing partial line (no newline) ---
const PARTIAL = '{"ev":{"role":"user","kind":"message","tool":"","text":"tail';

const fpA = writeGen("srcA", "aaaa", "proj1/sess-a.jsonl", "g0001.jsonl", [
  J({ type: "session", id: "sess-a", cwd: "/repo/x" }),
  ev("user", "message", "hello alpha", { timestamp: "2026-01-01T00:00:00.000Z" }),
  ev("assistant", "message", "hi back"),
  "{malformed",
].join("\n") + "\n");

const fpJson = writeGen("srcA", "bbbb", "proj1/pretty.json", "g0001.json", J([
  { ev: { role: "user", kind: "message", tool: "", text: "json user msg" } },
  { ev: { role: "assistant", kind: "tool", tool: "Bash", text: "ls -la" } },
], null, 2));

const fpB = writeGen("srcB", "cccc", "wiredir/wire.jsonl", "g0001.jsonl",
  ev("user", "message", "first b") + "\n" + PARTIAL);

test("fresh db needs rebuild; rebuild sets parserVersion", () => {
  assert.equal(needsRebuild(db), true);
  rebuild(db);
  assert.equal(needsRebuild(db), false);
});

test("initial index: events, opener, weight, context, bySource, gaps", async () => {
  const s = await idx();
  assert.equal(s.budgetHit, false);
  assert.equal(s.files, 3);
  assert.equal(s.parseErrors, 1); // the malformed line
  assert.equal(s.fileErrors, 0);
  assert.equal(s.mutated, 0);
  assert.equal(s.reset, 0);
  assert.equal(s.truncated, 0);
  assert.deepEqual(s.bySource.srcA, { events: 4, parseErrors: 1 });
  assert.deepEqual(s.bySource.srcB, { events: 1, parseErrors: 0 });

  const a = db.prepare("SELECT * FROM events WHERE text='hello alpha'").get();
  assert.equal(a.opener, 1);            // first user message of the file
  assert.equal(a.weight, 2.5);
  assert.equal(a.session, "sess-a");    // from the header via fileContext
  assert.equal(a.project, "/repo/x");   // fileCwd threaded to projectOf
  assert.equal(a.ts, "2026-01-01T00:00:00.000Z");
  assert.equal(a.line, 2);
  assert.equal(db.prepare("SELECT opener, weight FROM events WHERE text='hi back'").get().opener, 0);

  const ju = db.prepare("SELECT opener, weight, session FROM events WHERE text='json user msg'").get();
  assert.deepEqual([ju.opener, ju.weight, ju.session], [1, 2.5, "proj1"]);
  const jt = db.prepare("SELECT kind, tool, weight FROM events WHERE text='ls -la'").get();
  assert.deepEqual([jt.kind, jt.tool, jt.weight], ["tool", "Bash", 0.7]);

  // trailing partial line was NOT indexed, but IS a persistent reported gap
  assert.equal(count("SELECT count(*) c FROM events WHERE source='srcB'"), 1);
  assert.equal(count("SELECT count(*) c FROM events WHERE text LIKE 'tail%'"), 0);
  assert.deepEqual(gapSummary(db), { "json-parse": 1, "unterminated-tail": 1 });
  const g = db.prepare("SELECT * FROM index_gaps WHERE kind='json-parse'").get();
  assert.equal(g.path, fpA);
  assert.equal(g.line, 4);
  assert.ok(!g.detail.includes("malformed"), "gap detail must never contain content: " + g.detail);
  assert.equal(db.prepare("SELECT line FROM index_gaps WHERE kind='unterminated-tail'").get().line, 2);
});

test("no-op reindex touches nothing; gaps persist (B14 regression)", async () => {
  const s = await idx();
  assert.equal(s.files, 0);
  assert.equal(s.events, 0);
  // the permanent gaps must NOT vanish after a second run
  assert.equal(gapCount(db), 2);
  assert.deepEqual(gapSummary(db), { "json-parse": 1, "unterminated-tail": 1 });
});

test("growth resumes at byte offset; tail gap clears when line completes", async () => {
  // complete the partial line, then add one more full line
  fs.appendFileSync(fpB, '-b2"}}\n' + ev("assistant", "message", "resp b") + "\n");
  // grow the header file too: appended events must recover session via line 1
  fs.appendFileSync(fpA, ev("assistant", "message", "alpha again") + "\n");
  const s = await idx();
  assert.equal(s.files, 2);
  assert.equal(s.events, 3);
  assert.equal(s.reset, 0);
  for (const t of ["first b", "tail-b2", "resp b", "alpha again"])
    assert.equal(count("SELECT count(*) c FROM events WHERE text=?", t), 1, t);
  assert.equal(count("SELECT count(*) c FROM events WHERE source='srcB'"), 3);
  assert.equal(db.prepare("SELECT session FROM events WHERE text='alpha again'").get().session, "sess-a");
  // opener was already claimed by 'first b' in a previous run
  assert.equal(db.prepare("SELECT opener FROM events WHERE text='tail-b2'").get().opener, 0);
  // the unterminated-tail gap is resolved; the json-parse gap persists
  assert.deepEqual(gapSummary(db), { "json-parse": 1 });
});

test("changed *.json is reparsed whole without duplicates", async () => {
  fs.writeFileSync(fpJson, J([
    { ev: { role: "user", kind: "message", tool: "", text: "json user msg" } },
    { ev: { role: "assistant", kind: "tool", tool: "Bash", text: "ls -la" } },
    { ev: { role: "assistant", kind: "message", tool: "", text: "json third" } },
  ], null, 2));
  const s = await idx();
  assert.equal(s.files, 1);
  assert.equal(s.reset, 0);
  assert.equal(count("SELECT count(*) c FROM events WHERE path=?", fpJson), 3);
  assert.equal(count("SELECT count(*) c FROM events WHERE text='json user msg'"), 1);
});

test("shrink is archive corruption: events retained, archive-mutated gap, no reset", async () => {
  fs.writeFileSync(fpB, ev("user", "message", "post-shrink") + "\n");
  const s = await idx();
  assert.equal(s.reset, 0);
  assert.equal(s.mutated, 1);
  assert.equal(s.files, 0);          // shrunk file skipped, never reindexed
  // old events survive: shrink never auto-deletes indexed history
  assert.equal(count("SELECT count(*) c FROM events WHERE source='srcB'"), 3);
  assert.equal(count("SELECT count(*) c FROM events WHERE text='post-shrink'"), 0);
  assert.equal(count(`SELECT count(*) c FROM events_fts WHERE events_fts MATCH '"first"'`), 1);
  assert.equal(gapSummary(db)["archive-mutated"], 1);
  const g = db.prepare("SELECT * FROM index_gaps WHERE kind='archive-mutated'").get();
  assert.equal(g.path, fpB);
  assert.match(g.detail, /shrank/);
  // still refused (and still recorded) on the next run
  const s2 = await idx();
  assert.equal(s2.mutated, 1);
  assert.equal(count("SELECT count(*) c FROM events WHERE source='srcB'"), 3);
  assert.equal(gapSummary(db)["archive-mutated"], 1);
});

test("parser version bump -> rebuild -> reindex; gaps re-derived; FTS consistent", async () => {
  assert.ok(count("SELECT count(*) c FROM events") > 0);
  db.prepare("UPDATE meta SET v='0-old' WHERE k='parserVersion'").run();
  assert.equal(needsRebuild(db), true);
  rebuild(db);
  assert.equal(needsRebuild(db), false);
  assert.equal(db.prepare("SELECT v FROM meta WHERE k='parserVersion'").get().v, PARSER_VERSION);
  assert.equal(db.prepare("SELECT v FROM meta WHERE k='lastIndexStats'").get(), undefined);
  assert.equal(count("SELECT count(*) c FROM events"), 0);
  assert.equal(count("SELECT count(*) c FROM files"), 0);
  assert.equal(count("SELECT count(*) c FROM index_gaps"), 0);
  assert.equal(count("SELECT count(*) c FROM events_fts_docsize"), 0);

  let s;
  do { s = await idx(); } while (s.budgetHit);
  // fpB was rewritten smaller before rebuild; a full rebuild is the explicit
  // admin path that re-adopts it: 3 jsonl A + 3 json + 1 post-shrink = 7.
  assert.equal(count("SELECT count(*) c FROM events"), 7);
  assert.equal(count("SELECT count(*) c FROM events WHERE text='post-shrink'"), 1);
  // historical gaps re-derived by the rebuild (fpA's malformed line 4)
  assert.deepEqual(gapSummary(db), { "json-parse": 1 });
  // fts row count matches events row count after rebuild + reindex
  assert.equal(count("SELECT count(*) c FROM events_fts_docsize"), 7);
  db.exec("INSERT INTO events_fts(events_fts) VALUES('integrity-check')"); // throws if desynced
});

test("budgetMs exhausted -> budgetHit; next run picks the file up", async () => {
  writeGen("srcB", "dddd", "wiredir/more.jsonl", "g0001.jsonl", ev("user", "message", "late file") + "\n");
  const s0 = await idx({ budgetMs: -1 });
  assert.equal(s0.budgetHit, true);
  assert.equal(s0.files, 0);
  assert.equal(count("SELECT count(*) c FROM events WHERE text='late file'"), 0);
  const s1 = await idx();
  assert.equal(s1.budgetHit, false);
  assert.equal(count("SELECT count(*) c FROM events WHERE text='late file'"), 1);
});

test("eventCounts groups events and distinct sessions per source", () => {
  const c = eventCounts(db);
  assert.equal(c.srcA.events, 6);   // 3 jsonl + 3 json
  assert.equal(c.srcA.sessions, 2); // sess-a + proj1
  assert.equal(c.srcB.events, 2);   // post-shrink + late file
  assert.equal(c.srcB.sessions, 1); // both fall back to rel first dir "wiredir"
});

test(".partial and non-final generation names never index", async () => {
  const d = path.join(ARCHIVE, "srcB", "eeee");
  writeGen("srcB", "eeee", "wiredir/part.jsonl", "g0001.jsonl", ev("user", "message", "real one") + "\n");
  const partial = path.join(d, "g0002.jsonl.partial");
  fs.writeFileSync(partial, ev("user", "message", "partial canary") + "\n");
  fs.writeFileSync(path.join(d, "g001.jsonl"), ev("user", "message", "shortseq canary") + "\n"); // <4 digits
  fs.mkdirSync(path.join(d, "g0003.jsonl"));  // a DIRECTORY matching the regex: isFile() must reject
  const s = await idx();
  assert.equal(s.files, 1);
  assert.equal(count("SELECT count(*) c FROM events WHERE text='real one'"), 1);
  assert.equal(count("SELECT count(*) c FROM events WHERE text LIKE '%canary'"), 0);
  assert.equal(count("SELECT count(*) c FROM files WHERE path LIKE '%.partial'"), 0);
  // committing the generation (rename out of .partial) makes it indexable
  fs.renameSync(partial, path.join(d, "g0002.jsonl"));
  await idx();
  assert.equal(count("SELECT count(*) c FROM events WHERE text='partial canary'"), 1);
});

test("plain-text log generations remain raw-only without JSON parse gaps", async () => {
  const fixtures = [
    writeGen("grok", "rawlog-grok", "encoded-project/session/terminal/call-0001.log", "g0001.log", [
      "plain terminal output",
      ev("user", "message", "valid-json-looking-terminal-output"),
      "{not valid json",
    ].join("\n") + "\n"),
    writeGen("kimi-code", "rawlog-kimi-main", "wd_project/session/logs/kimi-code.log", "g0001.log", [
      "2026-07-22T10:00:00Z diagnostic line",
      "debug: request completed",
    ].join("\n") + "\n"),
    writeGen("kimi-code", "rawlog-kimi-output", "wd_project/session/agents/main/tasks/bash-1/output.log", "g0001.log", [
      "command output",
      "exit status 0",
    ].join("\n") + "\n"),
  ];
  const beforeHashes = new Map(fixtures.map((fp) => [fp, fileSha(fp)]));
  const before = gapCount(db);
  const s = await idx();
  assert.equal(s.files, 0);
  assert.equal(s.parseErrors, 0);
  assert.equal(gapCount(db), before);
  for (const fp of fixtures) {
    assert.equal(count("SELECT count(*) c FROM files WHERE path=?", fp), 0, fp);
    assert.equal(count("SELECT count(*) c FROM events WHERE path=?", fp), 0, fp);
    assert.equal(count("SELECT count(*) c FROM index_gaps WHERE path=?", fp), 0, fp);
    assert.equal(fileSha(fp), beforeHashes.get(fp), `raw-only artifact changed: ${fp}`);
  }
});

test("numeric gen sort; finalized gen tail parsed, newest gen tail stays pending", async () => {
  const d = path.join(ARCHIVE, "srcB", "ffff");
  writeGen("srcB", "ffff", "wiredir/tails.jsonl", "g9999.jsonl",
    ev("user", "message", "fin-line") + "\n" + ev("assistant", "message", "fin-tail")); // valid JSON tail, no \n
  fs.writeFileSync(path.join(d, "g10000.jsonl"),
    ev("user", "message", "act-line") + "\n" + '{"ev":{"role":"user"'); // truncated tail
  const s = await idx();
  assert.equal(s.files, 2);
  // g9999 is finalized (10000 > 9999 numerically — lexical sort would flip this):
  // its valid JSON tail is parsed as the final line and fully consumed
  assert.equal(count("SELECT count(*) c FROM events WHERE text='fin-tail'"), 1);
  const f = db.prepare("SELECT size, offset FROM files WHERE path=?").get(path.join(d, "g9999.jsonl"));
  assert.equal(f.offset, f.size);
  // g10000 (newest) keeps its tail pending + reported
  assert.equal(count("SELECT count(*) c FROM events WHERE text='act-line'"), 1);
  const g = db.prepare("SELECT * FROM index_gaps WHERE path=?").get(path.join(d, "g10000.jsonl"));
  assert.equal(g.kind, "unterminated-tail");
  // a second run does not rescan either file, and keeps the gap
  const s2 = await idx();
  assert.equal(s2.files, 0);
  assert.equal(count("SELECT count(*) c FROM index_gaps WHERE path=?", path.join(d, "g10000.jsonl")), 1);
});

test("oversized line is dropped with bounded carry; neighbors index at right lines", async () => {
  const big = Buffer.alloc(17 * 1024 * 1024, 120); // 17 MiB of 'x' > MAX_LINE, no newline inside
  writeGen("srcB", "gggg", "wiredir/big.jsonl", "g0001.jsonl", Buffer.concat([
    Buffer.from(ev("user", "message", "before-big") + "\n"),
    big, Buffer.from("\n"),
    Buffer.from(ev("assistant", "message", "after-big") + "\n"),
  ]));
  const s = await idx();
  assert.ok(s.truncated >= 1);
  assert.equal(db.prepare("SELECT line FROM events WHERE text='before-big'").get().line, 1);
  assert.equal(db.prepare("SELECT line FROM events WHERE text='after-big'").get().line, 3);
  const fp = path.join(ARCHIVE, "srcB", "gggg", "g0001.jsonl");
  const g = db.prepare("SELECT * FROM index_gaps WHERE path=? AND kind='oversized-line'").get(fp);
  assert.equal(g.line, 2);
  const f = db.prepare("SELECT size, offset, line FROM files WHERE path=?").get(fp);
  assert.equal(f.offset, f.size); // oversized line consumed past its newline
  assert.equal(f.line, 3);
  db.prepare("DELETE FROM index_gaps WHERE kind='oversized-line'").run(); // keep later summaries simple
});

test("oversized Codex compacted envelopes are ignored without false gaps", async () => {
  const compacted = JSON.stringify({
    timestamp: "2026-07-22T10:00:00.000Z",
    type: "compacted",
    payload: { message: "", replacement_history: ["x".repeat(17 * 1024 * 1024)], window_number: 1 },
  });
  const body = [
    ev("user", "message", "before-compacted"),
    compacted,
    ev("assistant", "message", "after-compacted"),
  ].join("\n") + "\n";
  const fp = writeGen("codex-active", "compact", "2026/07/22/rollout-compacted.jsonl", "g0001.jsonl", body);
  const before = gapCount(db);
  const s = await idx();
  assert.equal(s.files, 1);
  assert.equal(s.events, 2);
  assert.equal(s.parseErrors, 0);
  assert.equal(s.truncated, 0);
  assert.equal(gapCount(db), before);
  assert.equal(count("SELECT count(*) c FROM index_gaps WHERE path=?", fp), 0);
  assert.equal(count("SELECT count(*) c FROM events WHERE path=?", fp), 2);
  assert.equal(db.prepare("SELECT line FROM events WHERE text='before-compacted'").get().line, 1);
  assert.equal(db.prepare("SELECT line FROM events WHERE text='after-compacted'").get().line, 3);
  const f = db.prepare("SELECT size,offset,line FROM files WHERE path=?").get(fp);
  assert.deepEqual({ ...f }, { size: Buffer.byteLength(body), offset: Buffer.byteLength(body), line: 3 });
});

test("budget deadline honored INSIDE one huge file via mid-file checkpoint commit", async () => {
  const N = 30000;
  const lines = [];
  for (let i = 0; i < N; i++) lines.push(ev("user", "message", `bulk ${i}`));
  writeGen("srcB", "hhhh", "wiredir/bulk.jsonl", "g0001.jsonl", lines.join("\n") + "\n");
  // deadline trips as soon as any bulk event is visible in the open txn —
  // i.e. right after the first read chunk of this multi-MiB file.
  const tripped = () => count("SELECT count(*) c FROM events WHERE text LIKE 'bulk %'") > 0;
  const s = await idx({ _deadline: tripped });
  assert.equal(s.budgetHit, true);
  const n1 = count("SELECT count(*) c FROM events WHERE text LIKE 'bulk %'");
  assert.ok(n1 > 0 && n1 < N, `partial commit expected, got ${n1}`);
  const fp = path.join(ARCHIVE, "srcB", "hhhh", "g0001.jsonl");
  const f = db.prepare("SELECT size, offset, line FROM files WHERE path=?").get(fp);
  assert.ok(f.offset > 0 && f.offset < f.size, `mid-file checkpoint expected, offset=${f.offset}`);
  assert.equal(f.line, n1); // checkpoint line count consistent with committed events
  // the next run resumes at the checkpoint: everything indexed exactly once
  const s2 = await idx();
  assert.equal(s2.budgetHit, false);
  assert.equal(count("SELECT count(*) c FROM events WHERE text LIKE 'bulk %'"), N);
  assert.equal(count("SELECT count(DISTINCT text) c FROM events WHERE text LIKE 'bulk %'"), N);
});

test("txn/file failure counts as fileErrors, not parseErrors; stats and db untouched", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return t.skip("chmod test needs non-root");
  const fp = writeGen("srcB", "iiii", "wiredir/locked.jsonl", "g0001.jsonl",
    ev("user", "message", "locked out") + "\n");
  fs.chmodSync(fp, 0o000);
  const before = gapCount(db);
  const s = await idx();
  assert.equal(s.fileErrors, 1);
  assert.equal(s.parseErrors, 0);
  assert.equal(s.events, 0);
  assert.equal(count("SELECT count(*) c FROM events WHERE text='locked out'"), 0);
  assert.equal(count("SELECT count(*) c FROM files WHERE path=?", fp), 0);
  assert.equal(gapCount(db), before); // rollback reverted any in-txn gap writes
  fs.chmodSync(fp, 0o644);
  const s2 = await idx();
  assert.equal(s2.fileErrors, 0);
  assert.equal(count("SELECT count(*) c FROM events WHERE text='locked out'"), 1);
});

test("recordGap upserts on (path,line,kind) and bounds detail to 120 chars", () => {
  const before = gapCount(db);
  recordGap(db, { path: "/p", line: 7, kind: "json-parse", detail: "first" });
  recordGap(db, { path: "/p", line: 7, kind: "json-parse", detail: "y".repeat(500) });
  assert.equal(gapCount(db), before + 1);
  const g = db.prepare("SELECT detail FROM index_gaps WHERE path='/p' AND line=7").get();
  assert.equal(g.detail.length, 120);
  db.prepare("DELETE FROM index_gaps WHERE path='/p'").run();
});
