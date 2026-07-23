#!/usr/bin/env node
// Proves the positive guard fails for the intended reason under each known regression.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.umask(0o077);
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const guardRel = path.join("scripts", "verify-corruption-regressions.mjs");
const passLine = "GUARD_PASS false-corruption-classes=2 deliberate-oversized-gaps=1";

function runGuard(root) {
  return spawnSync(process.execPath, [path.join(root, guardRel)], {
    cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
}

function outputOf(result) { return `${result.stdout || ""}\n${result.stderr || ""}`.trim(); }
function die(message) { console.error(`NEGATIVE_CONTROL_FAIL: ${message}`); process.exit(1); }

const baseline = runGuard(repo);
if (baseline.status !== 0 || !outputOf(baseline).split("\n").includes(passLine))
  die(`baseline guard did not pass (status=${baseline.status})`);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "recall-negative-controls-"));
try {
  const mutations = [
    {
      name: "log-json-regression",
      label: "LOG_RAW_ONLY",
      apply(source) {
        const from = "const INDEX_GEN_RE = /^g(\\d{4,})\\.(?:jsonl|ndjson|json)$/;";
        const to = "const INDEX_GEN_RE = /^g(\\d{4,})\\.(?:jsonl|ndjson|json|log)$/;";
        const count = source.split(from).length - 1;
        if (count !== 1) die(`log mutation anchor count=${count}`);
        return source.replace(from, to);
      },
    },
    {
      name: "compacted-gap-regression",
      label: "COMPACTED_NO_GAP",
      apply(source) {
        const re = /if \(!isIgnorableOversizedRecord\((carry|lineBuf)\)\) \{/g;
        const matches = [...source.matchAll(re)];
        if (matches.length !== 2) die(`compacted mutation anchor count=${matches.length}`);
        return source.replace(re, "if (true) {");
      },
    },
  ];

  for (const mutation of mutations) {
    const root = path.join(temp, mutation.name);
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true, mode: 0o700 });
    fs.cpSync(path.join(repo, "lib"), path.join(root, "lib"), { recursive: true });
    fs.copyFileSync(path.join(repo, guardRel), path.join(root, guardRel));
    const dbPath = path.join(root, "lib", "db.mjs");
    fs.writeFileSync(dbPath, mutation.apply(fs.readFileSync(dbPath, "utf8")), { mode: 0o600 });
    const result = runGuard(root);
    const lines = outputOf(result).split("\n").filter(Boolean);
    const expected = `GUARD_FAIL ${mutation.label}:`;
    const failures = lines.filter((line) => line.startsWith("GUARD_FAIL "));
    if (result.status === 0 || failures.length !== 1 || !failures[0].startsWith(expected))
      die(`${mutation.name} status=${result.status} failures=${JSON.stringify(failures)}`);
    console.log(`NEGATIVE_CONTROL_PASS ${mutation.name} -> GUARD_FAIL ${mutation.label}`);
  }
  console.log("NEGATIVE_CONTROLS_PASS 2/2");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
