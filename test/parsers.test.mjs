import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRecord, fileContext, sessionOf, tsOf, projectOf,
  parseWholeJson, eventWeight, DECISION_RE,
} from "../lib/parsers.mjs";

const evs = (o) => [...parseRecord(o)];

// ---------- codex envelopes ----------

test("codex response_item message with input_text/output_text/text items", () => {
  const user = evs({
    timestamp: "2026-07-19T10:00:00.000Z", type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the parser" }] },
  });
  assert.deepEqual(user, [{ role: "user", kind: "message", tool: "", text: "fix the parser" }]);

  const asst = evs({
    timestamp: "t", type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }, { type: "text", text: "and tested" }] },
  });
  assert.deepEqual(asst.map((e) => e.text), ["done", "and tested"]);
  assert.ok(asst.every((e) => e.role === "assistant" && e.kind === "message"));
});

test("codex response_item function_call and function_call_output", () => {
  const call = evs({
    timestamp: "t", type: "response_item",
    payload: { type: "function_call", name: "shell", arguments: '{"command":["ls"]}' },
  });
  assert.deepEqual(call, [{ role: "assistant", kind: "tool", tool: "shell", text: '{"command":["ls"]}' }]);

  const out = evs({
    timestamp: "t", type: "response_item",
    payload: { type: "function_call_output", output: "file1\nfile2" },
  });
  assert.deepEqual(out, [{ role: "tool", kind: "tool_result", tool: "", text: "file1\nfile2" }]);
});

test("codex session_meta yields nothing but feeds fileContext", () => {
  const rec = {
    timestamp: "t", type: "session_meta",
    payload: { session_id: "0198a1b2-aaaa-bbbb-cccc-1234567890ab", id: "x", timestamp: "t", cwd: "/Users/jane/proj" },
  };
  assert.deepEqual(evs(rec), []);
  const ctx = fileContext(rec, {});
  assert.deepEqual(ctx, { session: "0198a1b2-aaaa-bbbb-cccc-1234567890ab", cwd: "/Users/jane/proj" });
});

test("codex event_msg: task_started nothing, agent_message text, reasoning-ish skipped", () => {
  assert.deepEqual(evs({ timestamp: "t", type: "event_msg", payload: { type: "task_started", model: "gpt" } }), []);
  assert.deepEqual(
    evs({ timestamp: "t", type: "event_msg", payload: { type: "agent_message", message: "hello there" } }),
    [{ role: "assistant", kind: "message", tool: "", text: "hello there" }]);
  assert.deepEqual(evs({ timestamp: "t", type: "event_msg", payload: { type: "agent_reasoning", text: "secret chain" } }), []);
});

test("codex reasoning response_item and turn_context yield nothing", () => {
  assert.deepEqual(evs({ timestamp: "t", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "hidden" }] } }), []);
  assert.deepEqual(evs({ timestamp: "t", type: "turn_context", payload: { cwd: "/x", instructions: "you are a system prompt" } }), []);
});

// ---------- kimi wire ----------

test("kimi turn.prompt yields user message", () => {
  const got = evs({ type: "turn.prompt", time: 1752900000000, input: [{ type: "text", text: "build the module" }] });
  assert.deepEqual(got, [{ role: "user", kind: "message", tool: "", text: "build the module" }]);
});

test("kimi context.append_message yields role/content and toolCalls", () => {
  const got = evs({
    type: "context.append_message", time: 1752900000001,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "on it" }],
      toolCalls: [{ id: "tc1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
    },
  });
  assert.deepEqual(got, [
    { role: "assistant", kind: "message", tool: "", text: "on it" },
    { role: "assistant", kind: "tool", tool: "bash", text: '{"cmd":"ls"}' },
  ]);
});

test("kimi config.update / metadata / system messages yield nothing (systemPrompt excluded)", () => {
  const leak = "SYSTEM PROMPT DO NOT INDEX";
  assert.deepEqual(evs({ type: "config.update", time: 1, config: { systemPrompt: leak, model: "kimi" } }), []);
  assert.deepEqual(evs({ type: "metadata", time: 1, version: 3 }), []);
  assert.deepEqual(evs({ type: "tools.set_active_tools", time: 1, tools: ["bash"] }), []);
  assert.deepEqual(evs({ type: "permission.set_mode", time: 1, mode: "auto" }), []);
  assert.deepEqual(evs({ type: "context.append_message", time: 1, message: { role: "system", content: [{ type: "text", text: leak }] } }), []);
});

// ---------- claude ----------

test("claude string content", () => {
  const got = evs({ type: "user", message: { role: "user", content: "hey what broke?" } });
  assert.deepEqual(got, [{ role: "user", kind: "message", tool: "", text: "hey what broke?" }]);
});

test("claude array content: text + tool_use + tool_result", () => {
  const got = evs({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "tu1", name: "Bash", input: { command: "git status" } },
      ],
    },
  });
  assert.deepEqual(got, [
    { role: "assistant", kind: "message", tool: "", text: "let me check" },
    { role: "assistant", kind: "tool", tool: "Bash", text: '{"command":"git status"}' },
  ]);

  const res = evs({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "clean tree" }] }] },
  });
  assert.deepEqual(res, [{ role: "user", kind: "tool_result", tool: "", text: "clean tree" }]);
});

test("claude thinking content is never yielded", () => {
  const got = evs({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret reasoning", signature: "sig==" },
        { type: "redacted_thinking", data: "blob" },
        { type: "text", text: "visible answer" },
      ],
    },
  });
  assert.deepEqual(got, [{ role: "assistant", kind: "message", tool: "", text: "visible answer" }]);
});

test("claude system-type records yield nothing", () => {
  assert.deepEqual(evs({ type: "system", content: "hook output", level: "info" }), []);
});

// ---------- pi ----------

test("pi session header: no events, fileContext accumulates, later records keep it", () => {
  const hdr = { type: "session", version: 1, id: "sess-abc123", timestamp: "2026-07-19T10:00:00Z", cwd: "/Users/jane/app" };
  assert.deepEqual(evs(hdr), []);
  let ctx = fileContext(hdr, {});
  assert.deepEqual(ctx, { session: "sess-abc123", cwd: "/Users/jane/app" });
  ctx = fileContext({ type: "message", role: "user", content: "hi" }, ctx);
  assert.deepEqual(ctx, { session: "sess-abc123", cwd: "/Users/jane/app" });
});

test("bare {role, content} message records parse (pi-style)", () => {
  const got = evs({ role: "assistant", content: [{ type: "text", text: "pi says hi" }] });
  assert.deepEqual(got, [{ role: "assistant", kind: "message", tool: "", text: "pi says hi" }]);
});

// ---------- generic fallback + tolerance ----------

test("generic fallback walks allowlist keys as kind other", () => {
  const got = evs({ foo: 1, prompt: "what is the plan" });
  assert.deepEqual(got, [{ role: "", kind: "other", tool: "", text: "what is the plan" }]);
});

test("generic fallback never surfaces system/thinking keys", () => {
  assert.deepEqual(evs({ systemPrompt: "leak", thinking: "leak", reasoning: "leak", signature: "leak" }), []);
  // nested skip-typed items are pruned even under allowlisted keys
  assert.deepEqual(evs({ output: { type: "reasoning", text: "leak" } }), []);
});

test("parseRecord tolerates garbage without throwing", () => {
  for (const bad of [null, undefined, 42, "str", [], {}, { type: 7 }]) {
    assert.deepEqual([...parseRecord(bad)], []);
  }
  // a string `message` key is legitimate generic-fallback text, not a crash
  assert.deepEqual(evs({ message: "notobj" }), [{ role: "", kind: "other", tool: "", text: "notobj" }]);
  const cyc = { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "x", input: {} }] } };
  cyc.message.content[0].input.self = cyc; // JSON.stringify would throw
  assert.doesNotThrow(() => [...parseRecord(cyc)]);
});

// ---------- parseWholeJson ----------

test("parseWholeJson: object, array, invalid", () => {
  assert.deepEqual(parseWholeJson('{\n  "role": "user",\n  "content": "hi"\n}'), [{ role: "user", content: "hi" }]);
  assert.deepEqual(parseWholeJson('[{"a":1},{"b":2}]'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(parseWholeJson(Buffer.from('{"a":1}')), [{ a: 1 }]);
  assert.throws(() => parseWholeJson("not json"));
  assert.throws(() => parseWholeJson('"just a string"'));
  assert.throws(() => parseWholeJson("42"));
});

// ---------- sessionOf ----------

test("sessionOf: explicit fields win", () => {
  assert.equal(sessionOf({ sessionId: "s-1" }, "/x/whatever.jsonl", "whatever.jsonl"), "s-1");
  assert.equal(sessionOf({ session_id: "s-2" }, "/x/whatever.jsonl", "whatever.jsonl"), "s-2");
  assert.equal(sessionOf({ type: "session", id: "hdr-id" }, "/x/wire.jsonl", "a/wire.jsonl"), "hdr-id");
  assert.equal(sessionOf({ type: "session_meta", payload: { session_id: "sm-id" } }, "/x/f.jsonl", "f.jsonl"), "sm-id");
});

test("sessionOf: UUID in basename", () => {
  const u = "0198a1b2-aaaa-bbbb-cccc-1234567890ab";
  assert.equal(sessionOf({}, `/arch/rollout-2026-07-19-${u}.jsonl`, `2026/07/rollout-2026-07-19-${u}.jsonl`), u);
});

test("sessionOf: kimi wire.jsonl uses first dir segment of rel (no collapse)", () => {
  assert.equal(sessionOf({}, "/arch/kimi/abc123def456/wire.jsonl", "abc123def456/wire.jsonl"), "abc123def456");
  assert.equal(sessionOf({}, "/arch/kimi/other999/wire.jsonl", "other999/wire.jsonl"), "other999");
});

test("sessionOf: falls back to basename sans extension", () => {
  assert.equal(sessionOf({}, "/arch/notes.jsonl", "notes.jsonl"), "notes");
});

// ---------- tsOf / projectOf ----------

test("tsOf: ISO passthrough, seconds and ms numbers", () => {
  assert.equal(tsOf({ timestamp: "2026-07-19T10:00:00.000Z" }), "2026-07-19T10:00:00.000Z");
  assert.equal(tsOf({ time: 1752919200000 }), new Date(1752919200000).toISOString());
  assert.equal(tsOf({ ts: 1752919200 }), new Date(1752919200000).toISOString());
  assert.equal(tsOf({}), "");
  assert.equal(tsOf(null), "");
});

test("projectOf precedence: fileCwd > obj.cwd > munged dir for claude/pi > empty", () => {
  assert.equal(projectOf({ cwd: "/b" }, "codex-active", "x/y", "/a"), "/a");
  assert.equal(projectOf({ cwd: "/b" }, "codex-active", "x/y", ""), "/b");
  assert.equal(projectOf({}, "claude-primary", "-Users-jane-app/sub", ""), "-Users-jane-app");
  assert.equal(projectOf({}, "pi", "--Users-jane-app--/f.jsonl", ""), "--Users-jane-app--");
  assert.equal(projectOf({}, "grok", "x/y", ""), "");
});

// ---------- eventWeight / DECISION_RE ----------

test("eventWeight base weights", () => {
  assert.equal(eventWeight({ role: "user", kind: "message", opener: true, text: "hi" }), 2.5);
  assert.equal(eventWeight({ role: "user", kind: "message", opener: false, text: "hi" }), 2.0);
  assert.equal(eventWeight({ role: "assistant", kind: "message", opener: false, text: "hi" }), 1.0);
  assert.equal(eventWeight({ role: "assistant", kind: "tool", opener: false, text: "{}" }), 0.7);
  assert.equal(eventWeight({ role: "tool", kind: "tool_result", opener: false, text: "ok" }), 0.5);
  assert.equal(eventWeight({ role: "", kind: "other", opener: false, text: "misc" }), 0.6);
});

test("eventWeight decision boost +0.5 capped at 3.0", () => {
  assert.equal(eventWeight({ role: "assistant", kind: "message", opener: false, text: "we decided to ship it" }), 1.5);
  assert.equal(eventWeight({ role: "user", kind: "message", opener: false, text: "actually that's wrong" }), 2.5);
  assert.equal(eventWeight({ role: "user", kind: "message", opener: true, text: "never use var, always const" }), 3.0);
});

// ---------- system-role exclusion at every boundary (B6) ----------

test("top-level role:system yields nothing regardless of type", () => {
  assert.deepEqual(evs({ type: "message", role: "system", content: "X" }), []);
  assert.deepEqual(evs({ role: "system", content: "X" }), []);
  assert.deepEqual(evs({ role: "system", content: [{ type: "text", text: "X" }] }), []);
  assert.deepEqual(evs({ type: "user", message: { role: "system", content: "X" } }), []);
});

test("role:system hidden at payload, content-item, and fallback-walk boundaries", () => {
  assert.deepEqual(evs({
    type: "response_item",
    payload: { type: "message", role: "system", content: [{ type: "input_text", text: "X" }] },
  }), []);
  assert.deepEqual(evs({
    type: "user",
    message: { role: "user", content: [{ type: "text", role: "system", text: "X" }] },
  }), []);
  assert.deepEqual(evs({ output: { role: "system", text: "leak" } }), []);
});

// ---------- tsOf hardening (B7) ----------

test("tsOf never throws: out-of-range finite numbers -> empty string", () => {
  assert.equal(tsOf({ timestamp: 1e300 }), "");
  assert.equal(tsOf({ timestamp: -1e300 }), "");
  assert.equal(tsOf({ ts: Number.MAX_SAFE_INTEGER }), "");
});

test("tsOf: pre-2001 millisecond stamps are not misread as seconds", () => {
  assert.equal(tsOf({ ts: 946684800000 }), "2000-01-01T00:00:00.000Z"); // ms (>=1e11)
  assert.equal(tsOf({ ts: 946684800 }), "2000-01-01T00:00:00.000Z");    // seconds
});

test("tsOf: strings are bounded to 128 chars and Date.parse-validated", () => {
  assert.equal(tsOf({ timestamp: "not a real date" }), "");
  assert.equal(tsOf({ timestamp: "z".repeat(4096) }), "");
  assert.equal(tsOf({ timestamp: "2026-07-19T10:00:00.000Z" }), "2026-07-19T10:00:00.000Z");
});

test("DECISION_RE matches decision/correction phrases only", () => {
  for (const s of ["we decided on sqlite", "let's go with plan B", "use tabs instead of spaces", "don't do that", "do not send", "that's wrong"]) {
    assert.ok(DECISION_RE.test(s), s);
  }
  assert.ok(!DECISION_RE.test("the weather is nice today"));
});
