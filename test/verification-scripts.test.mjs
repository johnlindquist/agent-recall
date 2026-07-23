import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function run(script, timeout = 180000) {
  return spawnSync(process.execPath, [path.join(repo, "scripts", script)], {
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
