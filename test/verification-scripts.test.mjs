import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function run(script, timeout = 180000) {
  return runArgs(script, [], timeout);
}

function runArgs(script, args, timeout = 180000) {
  return spawnSync(process.execPath, [path.join(repo, "scripts", script), ...args], {
    cwd: repo, encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
}

test("false-corruption guard passes the fixed source", () => {
  const result = run("verify-corruption-regressions.mjs");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^GUARD_PASS false-corruption-classes=2 deliberate-oversized-gaps=1$/m);
});

test("negative controls prove both known regressions are caught", () => {
  const result = run("verify-corruption-negative-controls.mjs", 360000);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^NEGATIVE_CONTROL_PASS log-json-regression -> GUARD_FAIL LOG_RAW_ONLY$/m);
  assert.match(result.stdout, /^NEGATIVE_CONTROL_PASS compacted-gap-regression -> GUARD_FAIL COMPACTED_NO_GAP$/m);
  assert.match(result.stdout, /^NEGATIVE_CONTROLS_PASS 2\/2$/m);
});

function archiveFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recall-archive-proof-test-"));
  const dir = path.join(root, "archive", "grok", "key");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "relpath.txt"), "project/session/call.log\n");
  fs.writeFileSync(path.join(dir, "g0001.log"), "preserved-prefix\n");
  fs.mkdirSync(path.join(root, "state"));
  fs.writeFileSync(path.join(root, "state", "archive-manifest.json"), JSON.stringify({ entries: {
    "grok project/session/call.log": { rel: "project/session/call.log", dirKey: "key", gens: ["g0001.log"] },
  } }));
  return { root, dir, snapshot: path.join(root, "snapshot.json") };
}

test("archive preservation verifier permits append and new generations", () => {
  const fixture = archiveFixture();
  try {
    const snap = runArgs("verify-archive-preservation.mjs", ["snapshot", "--root", fixture.root, "--out", fixture.snapshot]);
    assert.equal(snap.status, 0, `${snap.stdout}\n${snap.stderr}`);
    assert.equal(fs.statSync(fixture.snapshot).mode & 0o777, 0o600);
    fs.appendFileSync(path.join(fixture.dir, "g0001.log"), "append\n");
    fs.writeFileSync(path.join(fixture.dir, "g0002.log"), "new generation\n");
    const manifestPath = path.join(fixture.root, "state", "archive-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.entries["grok project/session/call.log"].gens.push("g0002.log");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const verify = runArgs("verify-archive-preservation.mjs", ["verify", "--root", fixture.root, "--snapshot", fixture.snapshot]);
    assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`);
    assert.match(verify.stdout, /^ARCHIVE_PRESERVATION_PASS .*grown=1 new=1$/m);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("archive preservation verifier rejects an old-prefix rewrite", () => {
  const fixture = archiveFixture();
  try {
    assert.equal(runArgs("verify-archive-preservation.mjs", ["snapshot", "--root", fixture.root, "--out", fixture.snapshot]).status, 0);
    fs.writeFileSync(path.join(fixture.dir, "g0001.log"), "rewritten-prefix\n");
    const verify = runArgs("verify-archive-preservation.mjs", ["verify", "--root", fixture.root, "--snapshot", fixture.snapshot]);
    assert.notEqual(verify.status, 0);
    assert.match(verify.stderr, /^ARCHIVE_PRESERVATION_FAIL: old prefix changed:/m);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("archive preservation verifier rejects deletion", () => {
  const fixture = archiveFixture();
  try {
    assert.equal(runArgs("verify-archive-preservation.mjs", ["snapshot", "--root", fixture.root, "--out", fixture.snapshot]).status, 0);
    fs.unlinkSync(path.join(fixture.dir, "g0001.log"));
    const verify = runArgs("verify-archive-preservation.mjs", ["verify", "--root", fixture.root, "--snapshot", fixture.snapshot]);
    assert.notEqual(verify.status, 0);
    assert.match(verify.stderr, /^ARCHIVE_PRESERVATION_FAIL:/m);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("installed verifier help is side-effect free", () => {
  const result = runArgs("verify-installed-recall.mjs", ["--help"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^usage: verify-installed-recall/m);
});
