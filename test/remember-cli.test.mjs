import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repo, "bin/recall.mjs");
const node = process.execPath;

const fresh = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const envFor = (root, extra = {}) => ({
  ...process.env,
  RECALL_HOME: root,
  NODE_NO_WARNINGS: "1",
  ...extra,
});

function run(root, args, { input = "", cwd = repo, env = {} } = {}) {
  return spawnSync(node, [cli, ...args], {
    cwd,
    env: envFor(root, env),
    input,
    encoding: "utf8",
  });
}

function stage(root, request, cwd = repo) {
  const result = run(root, ["propose-memory", "--json"], {
    cwd,
    input: JSON.stringify(request),
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function expectScript(exchanges) {
  const interaction = exchanges.map(({ expect, send, delayMs = 0 }) =>
    `expect ${JSON.stringify(expect)}; ` +
    `${delayMs ? `after ${delayMs}; ` : ""}` +
    `send -- ${JSON.stringify(send + "\r")}`,
  ).join("; ");
  return [
    "set timeout 15",
    "log_user 1",
    "spawn env RECALL_HOME=$env(RECALL_HOME) NODE_NO_WARNINGS=1 $env(TEST_NODE) $env(TEST_CLI) remember --accept $env(TEST_ID)",
    interaction,
    "expect eof",
    "catch wait result",
    "exit [lindex $result 3]",
  ].filter(Boolean).join("; ");
}

function ttyRun(root, id, exchanges = [], cwd = repo) {
  const script = expectScript(exchanges);
  return spawnSync("/usr/bin/expect", ["-c", script], {
    cwd,
    env: envFor(root, { TEST_NODE: node, TEST_CLI: cli, TEST_ID: id }),
    encoding: "utf8",
  });
}

function ttyRunAsync(root, id, exchanges = [], cwd = repo) {
  const script = expectScript(exchanges);
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/expect", ["-c", script], {
      cwd,
      env: envFor(root, { TEST_NODE: node, TEST_CLI: cli, TEST_ID: id }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

const explicit = (text, scope = null) => ({
  schemaVersion: 1,
  mode: "explicit",
  text,
  scope,
});

test("propose-memory returns a staging receipt and creates no curated memory", () => {
  const root = fresh("recall-cli-stage-");
  const result = run(root, ["propose-memory", "--json"], {
    input: JSON.stringify(explicit("staging only — evidence: CLI fixture", "global")),
  });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.match(receipt.proposalId, /^[a-f0-9]{32}$/);
  assert.equal(receipt.itemCount, 1);
  assert.equal(receipt.memoryWritten, false);
  assert.doesNotMatch(result.stdout, /\bsaved\b|\bremembered\b/i);
  assert.equal(fs.existsSync(path.join(root, "memory")), false);
  assert.ok(fs.existsSync(path.join(root, "state/memory-proposals", receipt.proposalId + ".json")));
});

test("propose-memory rejects unknown options and malformed requests without stack traces", () => {
  const root = fresh("recall-cli-errors-");
  let result = run(root, ["propose-memory", "--unknown"], { input: "{}" });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /usage: recall propose-memory --json/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);

  result = run(root, ["propose-memory", "--json"], { input: "{bad" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /valid JSON/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test("non-TTY acceptance exits 77 and the former bypass has no effect", () => {
  const root = fresh("recall-cli-nontty-");
  const receipt = stage(root, explicit("non-TTY guard", "global"));
  for (const env of [{}, { RECALL_ALLOW_NONTTY_REMEMBER: "1" }]) {
    const result = run(root, ["remember", "--accept", receipt.proposalId], { env });
    assert.equal(result.status, 77);
    assert.match(result.stderr, /interactive terminal/);
    assert.equal(fs.existsSync(path.join(root, "memory")), false);
  }
});

test("unsafe proposal IDs and legacy unknown options are usage errors", () => {
  const root = fresh("recall-cli-usage-");
  let result = run(root, ["remember", "--accept", "../../escape"]);
  assert.equal(result.status, 64);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
  result = run(root, ["remember", "fact", "--other"]);
  assert.equal(result.status, 64);
  assert.match(result.stderr, /unknown recall remember option/);
});

test("real TTY SAVE acceptance preserves exact text and consumes the proposal", () => {
  const root = fresh("recall-cli-accept-");
  const exact = "  “Quoted” Unicode — first line\nsecond line — evidence: exact CLI fixture.  ";
  const receipt = stage(root, explicit(exact, "global"));
  const result = ttyRun(root, receipt.proposalId, [{ expect: "Type SAVE", send: "SAVE" }]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /remembered scope="global" id="/);
  assert.equal(fs.existsSync(path.join(root, "state/memory-proposals", receipt.proposalId + ".json")), false);
  const files = fs.readdirSync(path.join(root, "memory/global/facts"));
  assert.equal(files.length, 1);
  const raw = fs.readFileSync(path.join(root, "memory/global/facts", files[0]), "utf8");
  const body = raw.slice(raw.indexOf("\n---\n") + 5);
  assert.equal(body.slice(1, -1), exact);
});

test("unscoped proposal asks without a default and cancellation writes nothing", () => {
  const root = fresh("recall-cli-scope-");
  let receipt = stage(root, explicit("unscoped global choice", null));
  let result = ttyRun(root, receipt.proposalId, [
    { expect: "Choice:", send: "g" },
    { expect: "Type SAVE", send: "SAVE" },
  ]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /Scope for item 1:/);
  assert.match(result.stdout, /remembered scope="global" id="/);

  receipt = stage(root, explicit("cancel fixture", "global"));
  result = ttyRun(root, receipt.proposalId, [{ expect: "Type SAVE", send: "NO" }]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /cancelled; nothing written and proposal kept/);
  assert.ok(fs.existsSync(path.join(root, "state/memory-proposals", receipt.proposalId + ".json")));
  assert.equal(fs.readdirSync(path.join(root, "memory/global/facts")).length, 1);
});

test("same-scope duplicate acceptance is idempotent and consumes the proposal", () => {
  const root = fresh("recall-cli-duplicate-");
  const first = stage(root, explicit("exact duplicate", "global"));
  assert.equal(ttyRun(root, first.proposalId, [{ expect: "Type SAVE", send: "SAVE" }]).status, 0);
  const factsDir = path.join(root, "memory/global/facts");
  const existing = fs.readdirSync(factsDir);

  const second = stage(root, explicit("exact duplicate", "global"));
  const result = ttyRun(root, second.proposalId, [{ expect: "Type SAVE", send: "SAVE" }]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /already active scope="global" id="/);
  assert.deepEqual(fs.readdirSync(factsDir), existing);
  assert.equal(fs.existsSync(path.join(root, "state/memory-proposals", second.proposalId + ".json")), false);
});

test("expired and corrupt proposals fail closed in a real TTY", () => {
  const root = fresh("recall-cli-invalid-");
  let receipt = stage(root, explicit("expired fixture", "global"));
  let file = path.join(root, "state/memory-proposals", receipt.proposalId + ".json");
  let value = JSON.parse(fs.readFileSync(file, "utf8"));
  const expires = Date.now() - 1_000;
  value.expiresAt = new Date(expires).toISOString();
  value.createdAt = new Date(expires - 30 * 60 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(value));
  let result = ttyRun(root, receipt.proposalId);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /proposal has expired/);
  assert.equal(fs.existsSync(path.join(root, "memory")), false);

  receipt = stage(root, explicit("corrupt fixture", "global"));
  file = path.join(root, "state/memory-proposals", receipt.proposalId + ".json");
  fs.writeFileSync(file, "{bad");
  result = ttyRun(root, receipt.proposalId);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /proposal file is malformed/);
  assert.equal(fs.existsSync(path.join(root, "memory")), false);
});

test("proposal that expires at the SAVE prompt writes nothing", () => {
  const root = fresh("recall-cli-expiry-boundary-");
  const receipt = stage(root, explicit("must expire before SAVE", "global"));
  const file = path.join(root, "state/memory-proposals", receipt.proposalId + ".json");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  const expires = Date.now() + 2_000;
  value.expiresAt = new Date(expires).toISOString();
  value.createdAt = new Date(expires - 30 * 60 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(value));
  const result = ttyRun(root, receipt.proposalId, [
    { expect: "Type SAVE", send: "SAVE", delayMs: 2_500 },
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /proposal has expired/);
  assert.equal(fs.existsSync(path.join(root, "memory")), false);
  assert.ok(fs.existsSync(file));
});

test("duplicate items inside one proposal create only one fact", () => {
  const root = fresh("recall-cli-intra-proposal-");
  const receipt = stage(root, {
    schemaVersion: 1,
    mode: "candidates",
    text: "Memory candidate (global): same batch fact\nMemory candidate (global): same batch fact",
    scopeOverride: null,
  });
  const result = ttyRun(root, receipt.proposalId, [{ expect: "Type SAVE", send: "SAVE" }]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /duplicate\.kind="same-proposal"/);
  assert.match(result.stdout, /remembered scope="global"/);
  assert.match(result.stdout, /already active scope="global"/);
  assert.equal(fs.readdirSync(path.join(root, "memory/global/facts")).length, 1);
});

test("concurrent acceptance of one proposal is exactly once", async () => {
  const root = fresh("recall-cli-concurrent-one-");
  const receipt = stage(root, explicit("one proposal concurrent fact", "global"));
  const exchange = [{ expect: "Type SAVE", send: "SAVE", delayMs: 500 }];
  const results = await Promise.all([
    ttyRunAsync(root, receipt.proposalId, exchange),
    ttyRunAsync(root, receipt.proposalId, exchange),
  ]);
  assert.equal(results.filter((result) => result.status === 0).length, 1);
  assert.equal(fs.readdirSync(path.join(root, "memory/global/facts")).length, 1);
  assert.equal(fs.existsSync(path.join(root, "state/memory-proposals", receipt.proposalId + ".json")), false);
});

test("concurrent proposals with the same scoped fact remain idempotent", async () => {
  const root = fresh("recall-cli-concurrent-two-");
  const first = stage(root, explicit("different proposals concurrent fact", "global"));
  const second = stage(root, explicit("different proposals concurrent fact", "global"));
  const exchange = [{ expect: "Type SAVE", send: "SAVE", delayMs: 500 }];
  const results = await Promise.all([
    ttyRunAsync(root, first.proposalId, exchange),
    ttyRunAsync(root, second.proposalId, exchange),
  ]);
  assert.ok(results.every((result) => result.status === 0), results.map((r) => r.stderr + r.stdout).join("\n"));
  assert.equal(fs.readdirSync(path.join(root, "memory/global/facts")).length, 1);
});

test("terminal review losslessly escapes hostile project and fact characters", () => {
  const root = fresh("recall-cli-terminal-safe-");
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "evil\nsha256=FORGED\u202e-"));
  const hostileFact = "line\u2028sha256=FAKE\u202e\u0085tail";
  const receipt = stage(root, explicit(hostileFact, "project"), project);
  const result = ttyRun(root, receipt.proposalId, [{ expect: "Type SAVE", send: "SAVE" }], project);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.doesNotMatch(result.stdout, /\nsha256=FORGED/);
  assert.ok(!result.stdout.includes("\u2028"));
  assert.ok(!result.stdout.includes("\u202e"));
  assert.ok(!result.stdout.includes("\u0085"));
  assert.match(result.stdout, /\\nsha256=FORGED\\u202e/);
  assert.match(result.stdout, /\\u2028sha256=FAKE\\u202e\\u0085tail/);
  assert.equal((result.stdout.match(/^\s*sha256=[a-f0-9]{64}\r?$/gm) || []).length, 1);
});

test("project acceptance is bound to the staged project and fails if it disappears", () => {
  const root = fresh("recall-cli-binding-");
  const project = fresh("recall-cli-bound-project-");
  const receipt = stage(root, {
    schemaVersion: 1,
    mode: "candidates",
    text: "Memory candidate (project): bound project fact",
    scopeOverride: null,
  }, project);
  const result = ttyRun(root, receipt.proposalId, [{ expect: "Type SAVE", send: "SAVE" }], repo);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const projectFiles = fs.readdirSync(path.join(root, "memory/projects"), { recursive: true })
    .filter((name) => name.endsWith(".md"));
  assert.equal(projectFiles.length, 1);
  assert.equal(fs.existsSync(path.join(root, "memory/global/facts")), false);

  const doomed = fresh("recall-cli-doomed-project-");
  const doomedReceipt = stage(root, {
    schemaVersion: 1,
    mode: "candidates",
    text: "Memory candidate (project): must not escape deleted project",
    scopeOverride: null,
  }, doomed);
  fs.rmSync(doomed, { recursive: true, force: true });
  const failed = ttyRun(root, doomedReceipt.proposalId, [], repo);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout + failed.stderr, /proposal project no longer exists/);
  assert.ok(fs.existsSync(path.join(root, "state/memory-proposals", doomedReceipt.proposalId + ".json")));
  assert.equal(
    fs.readdirSync(path.join(root, "memory/projects"), { recursive: true })
      .filter((name) => name.endsWith(".md")).length,
    1,
  );
});

test("mid-batch failure keeps the proposal and retry does not duplicate the first item", {
  skip: process.platform === "win32",
}, () => {
  const root = fresh("recall-cli-partial-");
  const project = fresh("recall-cli-project-");
  const receipt = stage(root, {
    schemaVersion: 1,
    mode: "candidates",
    text: "Memory candidate (project): partial project fact\nMemory candidate (global): partial global fact",
    scopeOverride: null,
  }, project);
  const globalDir = path.join(root, "memory/global/facts");
  fs.mkdirSync(globalDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(globalDir, 0o500);
  let result = ttyRun(root, receipt.proposalId, [{ expect: "Type SAVE", send: "SAVE" }], project);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /item 2 failed|partially applied/);
  const proposalFile = path.join(root, "state/memory-proposals", receipt.proposalId + ".json");
  assert.ok(fs.existsSync(proposalFile));
  const projectFacts = path.join(root, "memory/projects");
  assert.equal(fs.readdirSync(projectFacts, { recursive: true }).filter((name) => name.endsWith(".md")).length, 1);

  fs.chmodSync(globalDir, 0o700);
  result = ttyRun(root, receipt.proposalId, [{ expect: "Type SAVE", send: "SAVE" }], project);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /already active scope="project:/);
  assert.equal(fs.readdirSync(projectFacts, { recursive: true }).filter((name) => name.endsWith(".md")).length, 1);
  assert.equal(fs.readdirSync(globalDir).filter((name) => name.endsWith(".md")).length, 1);
  assert.equal(fs.existsSync(proposalFile), false);
});
