import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

process.env.RECALL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "recall-mem-"));
const { MEMORY } = await import("../lib/paths.mjs");
const { remember, contextFacts, forget, projectKey, findActiveDuplicate } = await import("../lib/memory.mjs");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "recall-proj-"));
const base = path.basename(fs.realpathSync(cwd));
const dirKey = projectKey(cwd).dirKey;

test("projectKey falls back to cwd outside git; variants include pi double-hyphen; dirKey is hashed", () => {
  const pk = projectKey(cwd);
  assert.equal(pk.base, path.basename(pk.top));
  assert.equal(pk.list.length, 4);
  assert.ok(pk.list[1].startsWith("-") && !pk.list[1].includes("/"));
  assert.equal(pk.list[2], `-${pk.list[1]}-`);
  assert.equal(pk.list[3], `-${pk.list[1]}--`); // pi historical double-trailing-hyphen form
  assert.match(pk.dirKey, /^v2-[0-9a-f]{64}$/);
  assert.equal(pk.kind, "plain");
  assert.equal(pk.gitDir, null);
  assert.equal(pk.gitDev, null);
  assert.equal(pk.gitIno, null);
  assert.equal(pk.gitBirthtimeNs, null);
});

test("projectKey binds the physical Git directory identity", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "recall-git-identity-"));
  assert.equal(spawnSync("git", ["init", "-q", project]).status, 0);
  const before = projectKey(project);
  assert.equal(before.kind, "git");
  assert.match(before.gitDev, /^\d+$/);
  assert.match(before.gitIno, /^\d+$/);
  assert.match(before.gitBirthtimeNs, /^\d+$/);
  fs.renameSync(path.join(project, ".git"), path.join(project, ".git-original"));
  assert.equal(spawnSync("git", ["init", "-q", project]).status, 0);
  const after = projectKey(project);
  assert.notEqual(after.gitIno, before.gitIno);
});

test("remember writes global and project facts with frontmatter", () => {
  const g = remember("We always use tabs", { cwd });
  assert.equal(g.scope, "global");
  assert.ok(g.file.startsWith(path.join(MEMORY, "global/facts")));
  const p = remember("This project uses Base UI, not Radix", { project: true, cwd });
  assert.equal(p.scope, `project:${base}`);
  assert.ok(p.file.includes(path.join("projects", dirKey, "facts")));
  const raw = fs.readFileSync(p.file, "utf8");
  for (const re of [/^id: /m, /^created: /m, /^scope: project$/m, new RegExp(`^project_key: ${dirKey}$`, "m"), /^status: active$/m, /^provenance: human-cli$/m])
    assert.match(raw, re);
});

test("remember rejects empty and oversized facts", () => {
  assert.throws(() => remember("   ", { cwd }));
  assert.throws(() => remember("x".repeat(8001), { cwd }));
});

test("remember round-trips exact whitespace, newlines, Unicode, quotes, and evidence", () => {
  const exact = "  “Quoted” Unicode — line one\nline two — evidence: exact fixture.  \n";
  const result = remember(exact, { cwd });
  assert.ok(result.id);
  const found = contextFacts({ cwd }).find((fact) => fact.id === result.id);
  assert.equal(found.fact, exact);
});

test("findActiveDuplicate is exact, active, and scope-specific", () => {
  const exact = "duplicate fixture — evidence: same scope";
  const global = remember(exact, { cwd });
  assert.equal(findActiveDuplicate(exact, { cwd })?.id, global.id);
  assert.equal(findActiveDuplicate(exact.toUpperCase(), { cwd }), null);
  assert.equal(findActiveDuplicate(exact, { project: true, cwd }), null);

  const project = remember(exact, { project: true, cwd });
  assert.equal(findActiveDuplicate(exact, { project: true, cwd })?.id, project.id);
  assert.deepEqual(forget(global.id, { cwd }), { action: "retracted", id: global.id });
  assert.equal(findActiveDuplicate(exact, { cwd }), null);
  const replacement = remember(exact, { cwd });
  assert.notEqual(replacement.id, global.id);
  assert.equal(findActiveDuplicate(exact, { cwd })?.id, replacement.id);
});

test("contextFacts returns both scopes and flags stale by created date", () => {
  const dir = path.join(MEMORY, "global/facts");
  const old = "2020-01-01T00:00:00.000Z";
  fs.writeFileSync(path.join(dir, "old-fact.md"),
    `---\nid: old-fact\ncreated: ${old}\nscope: global\nstatus: active\nprovenance: human-cli\n---\n\nAncient wisdom about the build\n`);
  const facts = contextFacts({ cwd });
  const byFact = Object.fromEntries(facts.map((f) => [f.fact, f]));
  assert.ok(byFact["We always use tabs"] && !byFact["We always use tabs"].stale);
  assert.equal(byFact["This project uses Base UI, not Radix"].scope, `project:${base}`);
  assert.equal(byFact["Ancient wisdom about the build"].stale, true);
  assert.equal(byFact["Ancient wisdom about the build"].id, "old-fact");
});

test("forget: zero matches -> none", () => {
  assert.deepEqual(forget("no such fact anywhere", { cwd }), { action: "none" });
});

test("forget: multiple matches -> candidates with id + 80-char fact", () => {
  const r = forget("use", { cwd }); // "use tabs" + "uses Base UI"
  assert.equal(r.action, "ambiguous");
  assert.ok(r.candidates.length >= 2);
  for (const c of r.candidates) {
    assert.ok(c.id && typeof c.fact === "string");
    assert.ok(c.fact.length <= 80);
  }
});

test("forget: exactly one match retracts status only, file kept, body untouched", () => {
  const target = contextFacts({ cwd }).find((f) => f.fact.includes("Base UI"));
  const r = forget("base ui", { cwd }); // case-insensitive
  assert.deepEqual(r, { action: "retracted", id: target.id });
  const file = path.join(MEMORY, "projects", dirKey, "facts", target.id + ".md");
  assert.ok(fs.existsSync(file));
  const raw = fs.readFileSync(file, "utf8");
  assert.match(raw, /^status: retracted$/m);
  assert.match(raw, /^retracted: \d{4}-\d{2}-\d{2}T/m);
  assert.doesNotMatch(raw, /^status: active$/m);
  assert.ok(raw.trimEnd().endsWith("This project uses Base UI, not Radix"));
});

test("retracted fact excluded from contextFacts and from further forget", () => {
  const facts = contextFacts({ cwd });
  assert.ok(!facts.some((f) => f.fact.includes("Base UI")));
  assert.deepEqual(forget("base ui", { cwd }), { action: "none" });
});

test("forget by full id works after ambiguity", () => {
  const tabs = contextFacts({ cwd }).find((f) => f.fact.includes("tabs"));
  const r = forget(tabs.id, { cwd });
  assert.deepEqual(r, { action: "retracted", id: tabs.id });
});

test("legacy plain-basename project data stays preserved but unbound", () => {
  const legacyDir = path.join(MEMORY, "projects", base, "facts");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "legacy-fact.md"),
    `---\nid: legacy-fact\ncreated: 2026-01-01T00:00:00.000Z\nscope: project:${base}\nstatus: active\nprovenance: human-cli\n---\n\nLegacy migration note about deployment\n`);
  const hit = contextFacts({ cwd }).find((f) => f.fact.includes("Legacy migration note"));
  assert.equal(hit, undefined, "legacy basename data must not bind to a current project");
  assert.equal(findActiveDuplicate("Legacy migration note about deployment", { project: true, cwd }), null);
  assert.deepEqual(forget("legacy migration note", { cwd }), { action: "none" });
  assert.match(fs.readFileSync(path.join(legacyDir, "legacy-fact.md"), "utf8"), /^status: active$/m);
});

test("same-basename projects and dirKey-like basenames cannot alias", () => {
  const parentA = fs.mkdtempSync(path.join(os.tmpdir(), "recall-client-a-"));
  const parentB = fs.mkdtempSync(path.join(os.tmpdir(), "recall-client-b-"));
  const apiA = path.join(parentA, "api");
  const apiB = path.join(parentB, "api");
  fs.mkdirSync(apiA);
  fs.mkdirSync(apiB);
  const fact = "same basename isolation fact";
  const written = remember(fact, { project: true, cwd: apiA });
  assert.equal(findActiveDuplicate(fact, { project: true, cwd: apiB }), null);
  assert.ok(!contextFacts({ cwd: apiB }).some((item) => item.fact === fact));
  assert.deepEqual(forget(fact, { cwd: apiB }), { action: "none" });
  assert.match(fs.readFileSync(written.file, "utf8"), /^status: active$/m);

  const keyLike = path.join(parentB, projectKey(apiA).dirKey);
  fs.mkdirSync(keyLike);
  assert.equal(findActiveDuplicate(fact, { project: true, cwd: keyLike }), null);
  assert.ok(!contextFacts({ cwd: keyLike }).some((item) => item.fact === fact));
});

test("project keys bound hostile and maximum-length basenames safely", () => {
  const hostile = fs.mkdtempSync(path.join(os.tmpdir(), "scope\n---\n\u0085\u061c-"));
  const hostileResult = remember("hostile project metadata fact", { project: true, cwd: hostile });
  const raw = fs.readFileSync(hostileResult.file, "utf8");
  assert.match(raw, /^scope: project$/m);
  assert.match(raw, /^project_key: v2-[a-f0-9]{64}$/m);
  assert.equal((raw.match(/^---$/gm) || []).length, 2);
  assert.equal(findActiveDuplicate("hostile project metadata fact", { project: true, cwd: hostile })?.id, hostileResult.id);

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "recall-long-parent-"));
  const longProject = path.join(parent, "x".repeat(245));
  fs.mkdirSync(longProject);
  const key = projectKey(longProject).dirKey;
  assert.ok(Buffer.byteLength(key) <= 255);
  const longResult = remember("long basename fact", { project: true, cwd: longProject });
  assert.ok(fs.existsSync(longResult.file));
});

test("remember survives id collisions (same ms, same fact) via wx retry with random suffix", () => {
  const RealDate = globalThis.Date;
  class FrozenDate extends RealDate { toISOString() { return "2026-07-19T12:00:00.000Z"; } }
  globalThis.Date = FrozenDate;
  const files = new Set();
  try {
    for (let i = 0; i < 10; i++) files.add(remember("collision fact", { cwd }).file);
  } finally { globalThis.Date = RealDate; }
  assert.equal(files.size, 10); // every invocation persisted its own file
  for (const f of files) assert.ok(fs.existsSync(f), f);
});

test("global remember works even without a usable cwd (git/projectKey skipped)", () => {
  const r = remember("global no-cwd fact", { cwd: "/definitely/not/a/dir" });
  assert.equal(r.scope, "global");
  assert.ok(fs.existsSync(r.file));
});

test("mutation-time scans fail closed on unreadable, malformed, and symlink facts", {
  skip: process.platform === "win32",
}, () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "recall-strict-store-"));
  const result = remember("strict store original", { project: true, cwd: isolated });
  fs.chmodSync(result.file, 0o000);
  assert.throws(
    () => findActiveDuplicate("strict store original", { project: true, cwd: isolated }),
  );
  fs.chmodSync(result.file, 0o600);
  assert.equal(findActiveDuplicate("strict store original", { project: true, cwd: isolated })?.id, result.id);

  const dir = path.dirname(result.file);
  const malformed = path.join(dir, "malformed.md");
  fs.writeFileSync(malformed, "not frontmatter\n", { mode: 0o600 });
  assert.throws(() => contextFacts({ cwd: isolated }), /malformed memory fact/);
  fs.unlinkSync(malformed);

  const target = path.join(os.tmpdir(), `recall-fact-target-${process.pid}.md`);
  fs.writeFileSync(target, "foreign\n", { mode: 0o600 });
  const link = path.join(dir, "linked.md");
  fs.symlinkSync(target, link);
  assert.throws(
    () => findActiveDuplicate("strict store original", { project: true, cwd: isolated }),
    /unsafe memory fact entry/,
  );
  fs.unlinkSync(link);
  fs.unlinkSync(target);
});

test("persisted facts require fatal UTF-8 and exact target metadata and body bounds", () => {
  const writeRawFact = (file, { id, scope, projectKey: key = null, fact }) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const projectLine = scope === "project" ? `project_key: ${key}\n` : "";
    fs.writeFileSync(file,
      `---\nid: ${id}\ncreated: 2026-07-22T00:00:00.000Z\nscope: ${scope}\n${projectLine}status: active\nprovenance: human-cli\n---\n\n${fact}\n`,
      { mode: 0o600 });
  };

  const globalDir = path.join(MEMORY, "global/facts");
  const malformedUtf8 = path.join(globalDir, "malformed-utf8.md");
  writeRawFact(malformedUtf8, {
    id: "malformed-utf8",
    scope: "global",
    fact: "literal replacement \ufffd",
  });
  const validBytes = fs.readFileSync(malformedUtf8);
  const replacementAt = validBytes.indexOf(Buffer.from("\ufffd"));
  assert.ok(replacementAt >= 0);
  fs.writeFileSync(malformedUtf8, Buffer.concat([
    validBytes.subarray(0, replacementAt),
    Buffer.from([0xff]),
    validBytes.subarray(replacementAt + Buffer.byteLength("\ufffd")),
  ]));
  assert.throws(() => contextFacts({ cwd }), /not valid UTF-8/);
  fs.unlinkSync(malformedUtf8);

  const projectA = fs.mkdtempSync(path.join(os.tmpdir(), "recall-target-a-"));
  const projectB = fs.mkdtempSync(path.join(os.tmpdir(), "recall-target-b-"));
  const targetA = projectKey(projectA);
  const targetB = projectKey(projectB);
  const dirA = path.join(MEMORY, "projects", targetA.dirKey, "facts");
  const dirB = path.join(MEMORY, "projects", targetB.dirKey, "facts");

  const globalInProject = path.join(dirA, "global-in-project.md");
  writeRawFact(globalInProject, {
    id: "global-in-project",
    scope: "global",
    fact: "wrong directory",
  });
  assert.throws(() => contextFacts({ cwd: projectA }), /invalid memory fact metadata/);
  fs.unlinkSync(globalInProject);

  const projectAInB = path.join(dirB, "project-a-in-b.md");
  writeRawFact(projectAInB, {
    id: "project-a-in-b",
    scope: "project",
    projectKey: targetA.dirKey,
    fact: "wrong project binding",
  });
  assert.throws(() => contextFacts({ cwd: projectB }), /invalid memory fact metadata/);
  fs.unlinkSync(projectAInB);

  const oversized = path.join(dirB, "oversized-body.md");
  writeRawFact(oversized, {
    id: "oversized-body",
    scope: "project",
    projectKey: targetB.dirKey,
    fact: "x".repeat(8001),
  });
  assert.throws(() => contextFacts({ cwd: projectB }), /exceeds 8000 chars/);
  fs.unlinkSync(oversized);
});

test("publication compares exact bytes and removes a mismatched visible fact", () => {
  const originalWrite = fs.writeFileSync;
  const before = fs.readdirSync(path.join(MEMORY, "global/facts"))
    .filter((name) => name.endsWith(".md")).sort();
  let injected = false;
  fs.writeFileSync = function faultInject(target, data, ...args) {
    if (!injected && typeof target === "number" && Buffer.isBuffer(data)) {
      const at = data.indexOf(Buffer.from("\ufffd"));
      if (at >= 0) {
        injected = true;
        data = Buffer.concat([
          data.subarray(0, at),
          Buffer.from([0xff]),
          data.subarray(at + Buffer.byteLength("\ufffd")),
        ]);
      }
    }
    return originalWrite.call(this, target, data, ...args);
  };
  try {
    assert.throws(
      () => remember("publication byte fault \ufffd", { cwd }),
      /memory fact readback mismatch/,
    );
  } finally {
    fs.writeFileSync = originalWrite;
  }
  assert.equal(injected, true);
  assert.deepEqual(
    fs.readdirSync(path.join(MEMORY, "global/facts"))
      .filter((name) => name.endsWith(".md")).sort(),
    before,
  );
});
