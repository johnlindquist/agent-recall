// Verification battery for bin/archive.mjs (oracle findings V2, V4-V11).
// Every test runs the archiver as a child process against a mkdtemp
// RECALL_HOME and a temp source dir (RECALL_ONLY_SELFTEST scoping).
import { test } from "node:test";
import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ARCHIVER = fileURLToPath(new URL("../bin/archive.mjs", import.meta.url));
const GEN_RE = /^g(\d{4,})\.(jsonl|ndjson|json|log|txt)$/;

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "recall-arch-"));
  const home = path.join(base, "home");
  const src = path.join(base, "src");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(src, { recursive: true });
  return { base, home, src };
}
function runArch(home, src, env = {}) {
  return spawnSync(process.execPath, [ARCHIVER], {
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1", RECALL_HOME: home, RECALL_ONLY_SELFTEST: "1", RECALL_SELFTEST_SOURCE: src, RECALL_TEST_CRASH_AT: "", RECALL_TEST_HOLD_AFTER_LOCK_MS: "", ...env },
  });
}
const manifestPath = (home) => path.join(home, "state", "archive-manifest.json");
const readManifest = (home) => JSON.parse(fs.readFileSync(manifestPath(home), "utf8"));
const dirtyPath = (home) => path.join(home, "state", "archive-dirty");

function entryDirs(home) {
  const root = path.join(home, "archive", "selftest");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((n) => !n.startsWith(".")).map((n) => path.join(root, n));
}
const gensIn = (dir) => fs.readdirSync(dir).filter((n) => GEN_RE.test(n)).sort();
function allGenFiles(home) {
  const out = [];
  for (const d of entryDirs(home)) for (const g of gensIn(d)) out.push(path.join(d, g));
  return out.sort();
}
function archiveFingerprint(home) {
  return allGenFiles(home).map((p) => `${p}:${fs.readFileSync(p).toString("base64")}`).join("|");
}
function rmrf(p) {
  // restore permissions first so cleanup of chmod-000 fixtures works
  try {
    const stack = [p];
    while (stack.length) {
      const d = stack.pop();
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { try { fs.chmodSync(d, 0o700); ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; } }
      for (const e of ents) if (e.isDirectory()) { const c = path.join(d, e.name); try { fs.chmodSync(c, 0o700); } catch {} stack.push(c); }
    }
  } catch {}
  fs.rmSync(p, { recursive: true, force: true });
}

test("V2: tail-preserving same-size rewrite creates a second generation", () => {
  const { base, home, src } = setup();
  try {
    const f = path.join(src, "a.jsonl");
    const tail = "T".repeat(4096);
    fs.writeFileSync(f, "A".repeat(8192) + tail);
    let r = runArch(home, src);
    assert.strictEqual(r.status, 0, r.stderr);
    const rewritten = "B".repeat(8192) + tail; // same size, same final 4096 bytes
    fs.writeFileSync(f, rewritten);
    r = runArch(home, src);
    assert.strictEqual(r.status, 0, r.stderr);
    const [dir] = entryDirs(home);
    const gens = gensIn(dir);
    assert.strictEqual(gens.length, 2, `expected 2 generations, got ${gens}`);
    assert.strictEqual(fs.readFileSync(path.join(dir, gens[1]), "utf8"), rewritten);
    const m = readManifest(home);
    assert.strictEqual(m.entries["selftest a.jsonl"].gens.length, 2);
  } finally { rmrf(base); }
});

test("V4: crash after-append-replace, rerun archives content exactly once", () => {
  const { base, home, src } = setup();
  try {
    const f = path.join(src, "a.jsonl");
    fs.writeFileSync(f, "abc");
    let r = runArch(home, src);
    assert.strictEqual(r.status, 0, r.stderr);
    fs.writeFileSync(f, "abcdef");
    r = runArch(home, src, { RECALL_TEST_CRASH_AT: "after-append-replace" });
    assert.strictEqual(r.status, 99);
    assert.ok(fs.existsSync(dirtyPath(home)), "dirty marker expected after crash");
    r = runArch(home, src);
    assert.strictEqual(r.status, 0, r.stderr);
    const [dir] = entryDirs(home);
    const gens = gensIn(dir);
    assert.strictEqual(gens.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(dir, gens[0]), "utf8"), "abcdef");
    const m = readManifest(home);
    assert.strictEqual(m.entries["selftest a.jsonl"].size, 6);
    assert.ok(!fs.existsSync(dirtyPath(home)), "dirty marker must be cleared");
    assert.strictEqual(m.lastRun.counts.errors, 0);
  } finally { rmrf(base); }
});

test("V5: crash after-generation-publish, rerun keeps both generations, no name reuse", () => {
  const { base, home, src } = setup();
  try {
    const f = path.join(src, "a.jsonl");
    const OLD = "OLD-".repeat(100) + "\n";
    const NEW = "NEW+".repeat(90) + "\n"; // rewrite: different size and tail
    fs.writeFileSync(f, OLD);
    let r = runArch(home, src);
    assert.strictEqual(r.status, 0, r.stderr);
    fs.writeFileSync(f, NEW);
    r = runArch(home, src, { RECALL_TEST_CRASH_AT: "after-generation-publish" });
    assert.strictEqual(r.status, 99);
    r = runArch(home, src);
    assert.strictEqual(r.status, 0, r.stderr);
    const [dir] = entryDirs(home);
    const gens = gensIn(dir);
    assert.deepStrictEqual(gens.map((g) => g.slice(0, 5)), ["g0001", "g0002"]);
    assert.strictEqual(fs.readFileSync(path.join(dir, gens[0]), "utf8"), OLD, "old generation must survive");
    assert.strictEqual(fs.readFileSync(path.join(dir, gens[1]), "utf8"), NEW, "published generation must not be clobbered");
    const m = readManifest(home);
    assert.deepStrictEqual(m.entries["selftest a.jsonl"].gens, gens, "orphan generation adopted");
    const tmpDir = path.join(home, "archive", ".tmp");
    assert.ok(!fs.existsSync(tmpDir) || fs.readdirSync(tmpDir).length === 0, "no leftover candidates");
    assert.ok(!fs.existsSync(dirtyPath(home)));
  } finally { rmrf(base); }
});

test("V6: corrupted and deleted manifest with nonempty archive fail closed", () => {
  const { base, home, src } = setup();
  try {
    fs.writeFileSync(path.join(src, "a.jsonl"), "history\n");
    let r = runArch(home, src);
    assert.strictEqual(r.status, 0, r.stderr);
    const before = archiveFingerprint(home);
    fs.writeFileSync(manifestPath(home), "{corrupt json!!!");
    r = runArch(home, src);
    assert.notStrictEqual(r.status, 0, "corrupt manifest must fail the run");
    assert.strictEqual(archiveFingerprint(home), before, "archive bytes untouched after corrupt-manifest run");
    assert.ok(fs.existsSync(manifestPath(home)), "damaged manifest is never auto-replaced");
    fs.rmSync(manifestPath(home));
    r = runArch(home, src);
    assert.notStrictEqual(r.status, 0, "missing manifest with committed generations must fail the run");
    assert.strictEqual(archiveFingerprint(home), before, "archive bytes untouched after missing-manifest run");
  } finally { rmrf(base); }
});

test("V7: second archiver exits 75 quickly while lock is held", async () => {
  const { base, home, src } = setup();
  try {
    fs.writeFileSync(path.join(src, "a.jsonl"), "x\n");
    const holder = spawn(process.execPath, [ARCHIVER], {
      env: { ...process.env, NODE_NO_WARNINGS: "1", RECALL_HOME: home, RECALL_ONLY_SELFTEST: "1", RECALL_SELFTEST_SOURCE: src, RECALL_TEST_HOLD_AFTER_LOCK_MS: "3000" },
      stdio: "ignore",
    });
    const lock = path.join(home, "state", "archive.lock");
    const t = Date.now();
    while (!fs.existsSync(path.join(lock, "owner.json")) && Date.now() - t < 5000) await new Promise((res) => setTimeout(res, 10));
    assert.ok(fs.existsSync(path.join(lock, "owner.json")), "holder never took the lock");
    const t1 = Date.now();
    const r = runArch(home, src);
    assert.strictEqual(r.status, 75, `expected 75, got ${r.status} ${r.stderr}`);
    assert.ok(Date.now() - t1 < 2000, "busy exit must be quick");
    const code = await new Promise((res) => holder.on("close", res));
    assert.strictEqual(code, 0, "holder run should succeed");
  } finally { rmrf(base); }
});

test("V8: .partial leftovers are quarantined out of the final namespace", () => {
  const { base, home, src } = setup();
  try {
    const f = path.join(src, "a.jsonl");
    fs.writeFileSync(f, "line1\n");
    let r = runArch(home, src);
    assert.strictEqual(r.status, 0, r.stderr);
    const [dir] = entryDirs(home);
    fs.writeFileSync(path.join(dir, "g0009.jsonl.partial"), '{"canary":true}\n');
    fs.appendFileSync(f, "line2\n");
    r = runArch(home, src);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith(".partial")), "no .partial in final namespace");
    const quar = path.join(home, "archive", ".quarantine");
    assert.ok(fs.existsSync(quar) && fs.readdirSync(quar).some((n) => n.includes("g0009.jsonl.partial")), "leftover quarantined");
    const gens = gensIn(dir);
    assert.strictEqual(gens.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(dir, gens[0]), "utf8"), "line1\nline2\n", "append still committed");
  } finally { rmrf(base); }
});

test("V9: tiny RECALL_MAX_ARCHIVE yields outcome incomplete with zero errors", () => {
  const { base, home, src } = setup();
  try {
    fs.writeFileSync(path.join(src, "a.jsonl"), "x".repeat(100));
    const r = runArch(home, src, { RECALL_MAX_ARCHIVE: "10" });
    assert.strictEqual(r.status, 0, r.stderr);
    const m = readManifest(home);
    assert.strictEqual(m.lastRun.outcome, "incomplete");
    assert.strictEqual(m.lastRun.counts.errors, 0, "cap rejection must not count as error (no EBADF)");
    assert.ok(m.lastRun.counts.archiveLimitSkipped >= 1);
    assert.strictEqual(allGenFiles(home).length, 0);
  } finally { rmrf(base); }
});

test("V10: RECALL_MAX_FILES=1 cursor archives 3 changed files within 4 runs", () => {
  const { base, home, src } = setup();
  try {
    for (const n of ["a.jsonl", "b.jsonl", "c.jsonl"]) fs.writeFileSync(path.join(src, n), `content of ${n}\n`);
    let archivedAll = false;
    for (let i = 0; i < 4 && !archivedAll; i++) {
      const r = runArch(home, src, { RECALL_MAX_FILES: "1" });
      assert.strictEqual(r.status, 0, r.stderr);
      const m = readManifest(home);
      assert.ok(m.lastRun.counts.changed <= 1, "mutation cap respected");
      archivedAll = ["a.jsonl", "b.jsonl", "c.jsonl"].every((n) => (m.entries[`selftest ${n}`] || { gens: [] }).gens.length === 1);
    }
    assert.ok(archivedAll, "all three files archived within 4 runs (cursor prevents starvation)");
    for (const p of allGenFiles(home)) {
      const body = fs.readFileSync(p, "utf8");
      assert.match(body, /^content of [abc]\.jsonl\n$/);
    }
  } finally { rmrf(base); }
});

test("V11: escape symlink, deep nesting, unreadable subtree surface in counters and outcome", () => {
  const { base, home, src } = setup();
  try {
    fs.writeFileSync(path.join(src, "good.jsonl"), "good\n");
    const outside = path.join(base, "outside.jsonl");
    fs.writeFileSync(outside, "ESCAPED-SECRET\n");
    fs.symlinkSync(outside, path.join(src, "esc.jsonl"));
    let deep = src;
    for (let i = 1; i <= 10; i++) { deep = path.join(deep, `d${i}`); fs.mkdirSync(deep); }
    fs.writeFileSync(path.join(deep, "deep.jsonl"), "deep\n");
    const locked = path.join(src, "locked");
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, "hidden.jsonl"), "hidden\n");
    fs.chmodSync(locked, 0o000);
    const r = runArch(home, src);
    assert.strictEqual(r.status, 1, `walk errors must fail the run: ${r.stderr}`);
    const m = readManifest(home);
    assert.ok(m.lastRun.counts.symlinkSkipped >= 1, "symlinkSkipped counter");
    assert.ok(m.lastRun.counts.walkErrors >= 1, "walkErrors counter");
    assert.ok(m.lastRun.counts.depthSkipped >= 1, "depthSkipped counter");
    assert.notStrictEqual(m.lastRun.outcome, "ok");
    for (const p of allGenFiles(home)) assert.ok(!fs.readFileSync(p, "utf8").includes("ESCAPED-SECRET"), "symlink target never archived");
    assert.strictEqual((m.entries["selftest good.jsonl"] || { gens: [] }).gens.length, 1, "good file still archived");
  } finally { rmrf(base); }
});
