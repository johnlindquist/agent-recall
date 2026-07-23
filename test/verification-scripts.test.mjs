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

function saveSkillFixture() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "recall-save-proof-"));
  const fixtureRepo = path.join(fixture, "repo");
  const root = path.join(fixture, "installed");
  const agentsSkills = path.join(fixture, "agents-skills");
  const source = path.join(fixtureRepo, "integration", "agent-recall-save");
  const installed = path.join(root, "integration", "agent-recall-save");
  for (const dir of [
    source,
    path.join(source, "agents"),
    installed,
    path.join(installed, "agents"),
    agentsSkills,
  ]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(source, "SKILL.md"), "canonical skill\n", { mode: 0o600 });
  fs.writeFileSync(path.join(source, "agents", "openai.yaml"), "canonical metadata\n", { mode: 0o600 });
  fs.copyFileSync(path.join(source, "SKILL.md"), path.join(installed, "SKILL.md"));
  fs.copyFileSync(path.join(source, "agents", "openai.yaml"), path.join(installed, "agents", "openai.yaml"));
  for (const dir of [installed, path.join(installed, "agents")]) fs.chmodSync(dir, 0o700);
  for (const file of [path.join(installed, "SKILL.md"), path.join(installed, "agents", "openai.yaml")])
    fs.chmodSync(file, 0o600);
  const link = path.join(agentsSkills, "agent-recall-save");
  fs.symlinkSync(installed, link);
  const args = [
    "--repo", fixtureRepo,
    "--root", root,
    "--agents-skills", agentsSkills,
    "--skills-only",
  ];
  return { fixture, fixtureRepo, root, agentsSkills, source, installed, link, args };
}

test("installed verifier proves canonical save skill bytes, modes, and managed link", () => {
  const fixture = saveSkillFixture();
  try {
    const result = runArgs("verify-installed-recall.mjs", fixture.args);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /^SAVE_SKILL_PASS files=2 link=/m);
  } finally { fs.rmSync(fixture.fixture, { recursive: true, force: true }); }
});

test("installed verifier rejects save-skill byte, mode, checkout-link, and foreign-link drift", () => {
  const cases = [
    {
      name: "altered bytes",
      mutate: (f) => fs.writeFileSync(path.join(f.installed, "SKILL.md"), "changed\n"),
      expected: /bytes differ/,
    },
    {
      name: "wrong mode",
      mutate: (f) => fs.chmodSync(path.join(f.installed, "agents", "openai.yaml"), 0o644),
      expected: /mode mismatch/,
    },
    {
      name: "checkout link",
      mutate: (f) => {
        fs.unlinkSync(f.link);
        fs.symlinkSync(f.source, f.link);
      },
      expected: /link target mismatch/,
    },
    {
      name: "foreign link",
      mutate: (f) => {
        const foreign = path.join(f.fixture, "foreign");
        fs.mkdirSync(foreign);
        fs.unlinkSync(f.link);
        fs.symlinkSync(foreign, f.link);
      },
      expected: /link target mismatch/,
    },
    {
      name: "symlinked canonical directory",
      mutate: (f) => {
        const foreign = path.join(f.fixture, "foreign-save");
        fs.renameSync(f.installed, foreign);
        fs.symlinkSync(foreign, f.installed);
      },
      expected: /not a real directory/,
    },
    {
      name: "symlinked metadata directory",
      mutate: (f) => {
        const agents = path.join(f.installed, "agents");
        const foreign = path.join(f.fixture, "foreign-agents");
        fs.renameSync(agents, foreign);
        fs.symlinkSync(foreign, agents);
      },
      expected: /not a real directory/,
    },
    {
      name: "hard-linked installed file",
      mutate: (f) => {
        const installedSkill = path.join(f.installed, "SKILL.md");
        fs.unlinkSync(installedSkill);
        fs.linkSync(path.join(f.source, "SKILL.md"), installedSkill);
      },
      expected: /hard-linked/,
    },
    {
      name: "unexpected installed file",
      mutate: (f) => fs.writeFileSync(path.join(f.installed, "EXTRA"), "extra\n"),
      expected: /unexpected entry/,
    },
    {
      name: "extra alias",
      mutate: (f) => fs.symlinkSync(f.installed, path.join(f.agentsSkills, "accept-memories")),
      expected: /unexpected save-skill alias/,
    },
  ];
  for (const control of cases) {
    const fixture = saveSkillFixture();
    try {
      control.mutate(fixture);
      const result = runArgs("verify-installed-recall.mjs", fixture.args);
      assert.notEqual(result.status, 0, `${control.name} unexpectedly passed`);
      assert.match(result.stderr, control.expected, control.name);
    } finally { fs.rmSync(fixture.fixture, { recursive: true, force: true }); }
  }
});
