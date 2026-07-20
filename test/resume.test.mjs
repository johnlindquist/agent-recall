import test from "node:test";
import assert from "node:assert/strict";
import { SAFE_ID, resumeHint } from "../lib/resume.mjs";

const UUID = "abf18dd9-111f-4ab5-ab89-00b2e570bdf4";

test("hostile session ids are rejected before templating", () => {
  const hostile = [
    "x; rm -rf ~",
    "$(cmd)",
    "`id`",
    "a b c",
    "it's-a-quote",
    'dq"uote-injection',
    "id\nnewline",
    "a".repeat(200),
    "short", // < 6 chars
    "",
    "semi;colon-1234",
    "dollar$var-1234",
  ];
  for (const source of ["claude-primary", "codex-active", "pi", "grok"]) {
    for (const id of hostile) {
      const hint = resumeHint(source, id);
      assert.equal(hint.cmd, null, `${source} ${JSON.stringify(id)}`);
      assert.equal(hint.note, "session id failed validation; resume manually");
    }
  }
  assert.equal(resumeHint("claude-primary", undefined).cmd, null);
  assert.equal(resumeHint("claude-primary", 12345678).cmd, null);
});

test("SAFE_ID accepts uuids, codex rollout ids, timestamps", () => {
  for (const id of [
    UUID,
    "rollout-2026-07-16T01-03-29-506Z",
    "2026-07-16T01-03-29-506Z_019f6873",
    "wire.session_01",
  ]) {
    assert.ok(SAFE_ID.test(id), id);
  }
});

test("claude-primary template", () => {
  assert.deepEqual(resumeHint("claude-primary", UUID), {
    cmd: `claude --resume ${UUID}`,
  });
});

test("claude-second template sets CLAUDE_CONFIG_DIR", () => {
  assert.deepEqual(resumeHint("claude-second", UUID), {
    cmd: `CLAUDE_CONFIG_DIR="$HOME/.claude-second" claude --resume ${UUID}`,
  });
});

test("codex templates (active and archived)", () => {
  const id = "2026-07-16T01-03-29-506Z_019f6873";
  assert.deepEqual(resumeHint("codex-active", id), { cmd: `codex resume ${id}` });
  assert.deepEqual(resumeHint("codex-archived", id), { cmd: `codex resume ${id}` });
});

test("pi template", () => {
  assert.deepEqual(resumeHint("pi", "session-123456"), {
    cmd: "pi --session session-123456",
  });
});

test("grok template is labeled unverified", () => {
  assert.deepEqual(resumeHint("grok", UUID), {
    cmd: `grok --resume ${UUID}  # unverified`,
  });
});

test("kimi sources have no cmd, picker note", () => {
  for (const source of ["kimi-code", "kimi-legacy"]) {
    assert.deepEqual(resumeHint(source, UUID), {
      cmd: null,
      note: "open kimi and use its resume picker (unverified)",
    });
  }
});

test("selftest/unknown sources yield null cmd", () => {
  assert.equal(resumeHint("selftest", UUID).cmd, null);
  assert.equal(resumeHint("some-future-source", UUID).cmd, null);
});
