import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.RECALL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "recall-proposals-"));
const {
  PROPOSAL_SCHEMA_VERSION,
  PROPOSAL_TTL_MS,
  PROPOSAL_ID_RE,
  MAX_LIVE_PROPOSALS,
  parseCandidateBlock,
  parseProposalRequest,
  createMemoryProposal,
  loadMemoryProposal,
  removeMemoryProposal,
} = await import("../lib/memory-proposals.mjs");
const { MEMORY_PROPOSALS, MEMORY } = await import("../lib/paths.mjs");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "recall-proposal-project-"));
const cli = fileURLToPath(new URL("../bin/recall.mjs", import.meta.url));
const candidateRequest = (text, scopeOverride = null) => ({
  schemaVersion: 1,
  mode: "candidates",
  text,
  scopeOverride,
});
const explicitRequest = (text, scope = null) => ({
  schemaVersion: 1,
  mode: "explicit",
  text,
  scope,
});

beforeEach(() => {
  fs.rmSync(MEMORY_PROPOSALS, { recursive: true, force: true });
});

test("canonical one- and two-line candidate blocks preserve payload and scopes", () => {
  assert.deepEqual(parseCandidateBlock("Memory candidate (project): Use Base UI — evidence: package.json."), [
    { fact: "Use Base UI — evidence: package.json.", scope: "project" },
  ]);
  assert.deepEqual(parseCandidateBlock(
    "Memory candidate (global): Keep “quotes” and \\\\slashes.\r\nMemory candidate: unresolved suffix  ",
  ), [
    { fact: "Keep “quotes” and \\\\slashes.", scope: "global" },
    { fact: "unresolved suffix  ", scope: null },
  ]);
});

test("candidate parser rejects missing, extra, malformed, quoted, fenced, and prose-mixed forms", () => {
  const bad = [
    "",
    "Memory candidate (project): ",
    "Memory candidate (project): a\nMemory candidate (global): b\nMemory candidate: c",
    "- Memory candidate (project): a",
    "> Memory candidate (project): a",
    "```\nMemory candidate (project): a\n```",
    "Here you go\nMemory candidate (project): a",
    "Memory candidate (other): a",
    "Memory candidate(project): a",
  ];
  for (const value of bad) assert.throws(() => parseCandidateBlock(value), value);
});

test("strict request schema preserves explicit text and applies only explicit scope overrides", () => {
  const exact = "  Keep \"quotes\", 'apostrophes', \\\\slashes, Unicode —\nand trailing space.  ";
  assert.deepEqual(parseProposalRequest(explicitRequest(exact)), {
    mode: "explicit",
    items: [{ fact: exact, scope: null }],
  });
  assert.deepEqual(parseProposalRequest(candidateRequest(
    "Memory candidate (project): first\nMemory candidate: second",
    "global",
  )), {
    mode: "candidates",
    items: [
      { fact: "first", scope: "global" },
      { fact: "second", scope: "global" },
    ],
  });
});

test("strict request schema rejects unknown keys, modes, versions, scopes, empties, and oversized facts", () => {
  const bad = [
    { ...explicitRequest("x"), extra: true },
    { ...explicitRequest("x"), schemaVersion: 2 },
    { ...explicitRequest("x"), mode: "automatic" },
    explicitRequest("x", "other"),
    explicitRequest("  ", "global"),
    explicitRequest("x".repeat(8001), "global"),
    { schemaVersion: 1, mode: "candidates", text: "Memory candidate: x" },
  ];
  for (const value of bad) assert.throws(() => parseProposalRequest(value));
  assert.throws(() => parseProposalRequest("{not json"));
});

test("proposal creation is outside memory, writes no fact, and returns a false-win receipt", () => {
  const exact = "proposal only — evidence: no memory write";
  const receipt = createMemoryProposal(parseProposalRequest(explicitRequest(exact, "global")), { cwd });
  assert.match(receipt.proposalId, PROPOSAL_ID_RE);
  assert.equal(receipt.itemCount, 1);
  assert.equal(receipt.memoryWritten, false);
  assert.equal(receipt.acceptCommand, `recall remember --accept ${receipt.proposalId}`);
  assert.ok(path.resolve(MEMORY_PROPOSALS).startsWith(path.resolve(process.env.RECALL_HOME) + path.sep));
  assert.ok(!path.resolve(MEMORY_PROPOSALS).startsWith(path.resolve(MEMORY) + path.sep));
  assert.equal(fs.existsSync(MEMORY), false);
  const proposal = loadMemoryProposal(receipt.proposalId);
  assert.equal(proposal.items[0].fact, exact);
  assert.equal(proposal.project, null);
});

test("project-capable proposals bind the creation project and use private modes", () => {
  const receipt = createMemoryProposal(parseProposalRequest(candidateRequest(
    "Memory candidate (project): project fact\nMemory candidate (global): global fact",
  )), { cwd });
  const proposal = loadMemoryProposal(receipt.proposalId);
  assert.equal(proposal.project.top, fs.realpathSync(cwd));
  assert.equal(proposal.items.length, 2);
  assert.equal(fs.statSync(MEMORY_PROPOSALS).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(MEMORY_PROPOSALS, receipt.proposalId + ".json")).mode & 0o777, 0o600);
  removeMemoryProposal(receipt.proposalId);
  assert.equal(fs.existsSync(path.join(MEMORY_PROPOSALS, receipt.proposalId + ".json")), false);
});

test("proposal IDs are random and the live proposal cap is enforced", () => {
  const ids = new Set();
  const parsed = parseProposalRequest(explicitRequest("cap fixture", "global"));
  for (let i = 0; i < MAX_LIVE_PROPOSALS; i++)
    ids.add(createMemoryProposal(parsed, { cwd, now: 1_800_000_000_000 }).proposalId);
  assert.equal(ids.size, MAX_LIVE_PROPOSALS);
  assert.throws(
    () => createMemoryProposal(parsed, { cwd, now: 1_800_000_000_000 }),
    /too many live memory proposals/,
  );
});

test("multiprocess proposal staging never exceeds the strict live cap", async () => {
  const input = JSON.stringify(explicitRequest("concurrent cap fixture", "global"));
  const stageOne = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "propose-memory", "--json"], {
      cwd,
      env: { ...process.env, RECALL_HOME: process.env.RECALL_HOME, NODE_NO_WARNINGS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
  const results = await Promise.all(Array.from({ length: 64 }, stageOne));
  const files = fs.readdirSync(MEMORY_PROPOSALS).filter((name) => /^[a-f0-9]{32}\.json$/.test(name));
  assert.equal(files.length, MAX_LIVE_PROPOSALS);
  assert.equal(results.filter((result) => result.status === 0).length, MAX_LIVE_PROPOSALS);
  assert.ok(results.filter((result) => result.status !== 0)
    .every((result) => /too many live memory proposals/.test(result.stderr)));
});

test("expired proposals fail closed and are removed by bounded cleanup", () => {
  const now = 1_800_000_000_000;
  const receipt = createMemoryProposal(parseProposalRequest(explicitRequest("expires", "global")), { cwd, now });
  assert.throws(() => loadMemoryProposal(receipt.proposalId, { now: now + PROPOSAL_TTL_MS }), /expired/);
  createMemoryProposal(parseProposalRequest(explicitRequest("fresh", "global")), {
    cwd,
    now: now + PROPOSAL_TTL_MS,
  });
  assert.equal(fs.existsSync(path.join(MEMORY_PROPOSALS, receipt.proposalId + ".json")), false);
});

test("corrupt, hash-mismatched, wrong-version, and symlink proposals fail closed", () => {
  const create = () => createMemoryProposal(
    parseProposalRequest(explicitRequest("tamper fixture", "global")),
    { cwd },
  );

  let receipt = create();
  let file = path.join(MEMORY_PROPOSALS, receipt.proposalId + ".json");
  fs.writeFileSync(file, "{bad json\n");
  assert.throws(() => loadMemoryProposal(receipt.proposalId), /malformed/);

  fs.rmSync(MEMORY_PROPOSALS, { recursive: true, force: true });
  receipt = create();
  file = path.join(MEMORY_PROPOSALS, receipt.proposalId + ".json");
  let value = JSON.parse(fs.readFileSync(file, "utf8"));
  value.items[0].fact = "changed";
  fs.writeFileSync(file, JSON.stringify(value));
  assert.throws(() => loadMemoryProposal(receipt.proposalId), /validation/);

  fs.rmSync(MEMORY_PROPOSALS, { recursive: true, force: true });
  receipt = create();
  file = path.join(MEMORY_PROPOSALS, receipt.proposalId + ".json");
  value = JSON.parse(fs.readFileSync(file, "utf8"));
  value.schemaVersion = PROPOSAL_SCHEMA_VERSION + 1;
  fs.writeFileSync(file, JSON.stringify(value));
  assert.throws(() => loadMemoryProposal(receipt.proposalId), /schema version/);

  fs.rmSync(MEMORY_PROPOSALS, { recursive: true, force: true });
  receipt = create();
  file = path.join(MEMORY_PROPOSALS, receipt.proposalId + ".json");
  const target = path.join(process.env.RECALL_HOME, "proposal-target.json");
  fs.renameSync(file, target);
  fs.symlinkSync(target, file);
  assert.throws(() => loadMemoryProposal(receipt.proposalId), /regular file/);
});
