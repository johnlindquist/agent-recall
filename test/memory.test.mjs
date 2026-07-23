import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  // dirKey = slug(base) + 10-char toplevel hash: basename collisions can't share a dir
  assert.match(pk.dirKey, /^[a-z0-9][a-z0-9-]*-[0-9a-f]{10}$/);
  assert.ok(pk.dirKey.startsWith(pk.base.toLowerCase().replace(/[^a-z0-9]+/g, "-")));
});

test("remember writes global and project facts with frontmatter", () => {
  const g = remember("We always use tabs", { cwd });
  assert.equal(g.scope, "global");
  assert.ok(g.file.startsWith(path.join(MEMORY, "global/facts")));
  const p = remember("This project uses Base UI, not Radix", { project: true, cwd });
  assert.equal(p.scope, `project:${base}`);
  assert.ok(p.file.includes(path.join("projects", dirKey, "facts")));
  const raw = fs.readFileSync(p.file, "utf8");
  for (const re of [/^id: /m, /^created: /m, /^scope: project:/m, /^status: active$/m, /^provenance: human-cli$/m])
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

test("legacy plain-basename project dir stays readable (migration compat)", () => {
  const legacyDir = path.join(MEMORY, "projects", base, "facts");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "legacy-fact.md"),
    `---\nid: legacy-fact\ncreated: 2026-01-01T00:00:00.000Z\nscope: project:${base}\nstatus: active\nprovenance: human-cli\n---\n\nLegacy migration note about deployment\n`);
  const hit = contextFacts({ cwd }).find((f) => f.fact.includes("Legacy migration note"));
  assert.ok(hit, "legacy-dir fact must surface in contextFacts");
  assert.equal(hit.id, "legacy-fact");
  // forget reaches into the legacy dir too
  assert.deepEqual(forget("legacy migration note", { cwd }), { action: "retracted", id: "legacy-fact" });
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
