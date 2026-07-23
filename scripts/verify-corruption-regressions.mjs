#!/usr/bin/env node
// Hermetic end-to-end guard for the two false-corruption classes fixed in v4.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.umask(0o077);

class GuardError extends Error {
  constructor(label, detail) { super(detail); this.label = label; }
}

const fail = (label, detail) => { throw new GuardError(label, String(detail).slice(0, 240)); };
const requireGuard = (label, condition, detail) => { if (!condition) fail(label, detail); };
const json = (value) => JSON.stringify(value);

function writeGeneration(archive, source, key, rel, name, body = "") {
  const dir = path.join(archive, source, key);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "relpath.txt"), rel + "\n", { mode: 0o600 });
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, body, { mode: 0o600 });
  return fp;
}

function appendText(fd, text) {
  const buf = Buffer.from(text);
  let offset = 0;
  while (offset < buf.length) offset += fs.writeSync(fd, buf, offset, buf.length - offset);
}

function appendRepeated(fd, byte, total) {
  const chunk = Buffer.alloc(256 * 1024, byte);
  for (let left = total; left > 0; ) {
    const n = Math.min(left, chunk.length);
    let offset = 0;
    while (offset < n) offset += fs.writeSync(fd, chunk, offset, n - offset);
    left -= n;
  }
}

function writeCodexFixture(archive, key, rel, { compacted }) {
  const fp = writeGeneration(archive, "codex-active", key, rel, "g0001.jsonl");
  const fd = fs.openSync(fp, "w", 0o600);
  try {
    if (compacted) {
      appendText(fd, json({ timestamp: "2026-07-22T10:00:00.000Z", type: "session_meta", payload: { id: "019f0000-0000-7000-8000-000000000001", cwd: "/guard" } }) + "\n");
      appendText(fd, json({ timestamp: "2026-07-22T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "guard-before-compacted" }] } }) + "\n");
      appendText(fd, '{"timestamp":"2026-07-22T10:00:02.000Z","type":"compacted","payload":{"message":"","replacement_history":["');
      appendRepeated(fd, 120, 17 * 1024 * 1024);
      appendText(fd, '"],"window_number":1}}\n');
      appendText(fd, json({ timestamp: "2026-07-22T10:00:03.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "guard-after-compacted" }] } }) + "\n");
    } else {
      appendText(fd, '{"timestamp":"2026-07-22T11:00:00.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"nested type compacted ');
      appendRepeated(fd, 121, 17 * 1024 * 1024);
      appendText(fd, '"}]}}\n');
      appendText(fd, json({ timestamp: "2026-07-22T11:00:01.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "guard-after-real-oversized" }] } }) + "\n");
    }
  } finally { fs.closeSync(fd); }
  return fp;
}

function shaFile(fp) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(fp, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (let pos = 0; ; ) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      pos += n;
    }
  } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recall-corruption-guard-"));
  process.env.RECALL_HOME = root;
  let db;
  try {
    const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const paths = await import(pathToFileURL(path.join(repo, "lib/paths.mjs")).href);
    const dbmod = await import(pathToFileURL(path.join(repo, "lib/db.mjs")).href);
    const parsers = await import(pathToFileURL(path.join(repo, "lib/parsers.mjs")).href);
    const { ARCHIVE, PARSER_VERSION } = paths;

    const logFiles = [
      writeGeneration(ARCHIVE, "grok", "raw-grok", "encoded-project/session/terminal/call-0001.log", "g0001.log", [
        "plain terminal output",
        json({ role: "user", content: "valid-json-looking-log-record" }),
        "{not valid json",
      ].join("\n") + "\n"),
      writeGeneration(ARCHIVE, "kimi-code", "raw-kimi-main", "wd_project/session/logs/kimi-code.log", "g0001.log", "2026-07-22T10:00:00Z diagnostic line\n"),
      writeGeneration(ARCHIVE, "kimi-code", "raw-kimi-output", "wd_project/session/agents/main/tasks/bash-1/output.log", "genuine command output\n"),
    ];
    const structured = [
      writeGeneration(ARCHIVE, "grok", "structured-grok", "encoded-project/session/messages.jsonl", "g0001.jsonl", json({ role: "user", content: "structured-grok-control" }) + "\n"),
      writeGeneration(ARCHIVE, "kimi-code", "structured-kimi", "wd_project/session/wire.jsonl", "g0001.jsonl", json({ type: "turn.prompt", input: "structured-kimi-control" }) + "\n"),
    ];
    const compactedFile = writeCodexFixture(ARCHIVE, "codex-compacted", "2026/07/22/rollout-compacted.jsonl", { compacted: true });
    const oversizedFile = writeCodexFixture(ARCHIVE, "codex-oversized", "2026/07/22/rollout-oversized.jsonl", { compacted: false });
    const fixtures = [...logFiles, ...structured, compactedFile, oversizedFile];
    const beforeHashes = new Map(fixtures.map((fp) => [fp, shaFile(fp)]));

    db = dbmod.dbOpen();
    dbmod.rebuild(db);
    const stats = await dbmod.indexAll(db, { budgetMs: 120000, parsers });
    requireGuard("STRUCTURED_CONTROL_INDEXED",
      !stats.budgetHit && stats.fileErrors === 0 &&
      db.prepare("SELECT count(*) AS c FROM events WHERE text IN ('structured-grok-control','structured-kimi-control')").get().c === 2,
      `events=${stats.events} fileErrors=${stats.fileErrors} budgetHit=${stats.budgetHit}`);

    const logCheckpointed = logFiles.reduce((n, fp) => n + db.prepare("SELECT count(*) AS c FROM files WHERE path=?").get(fp).c, 0);
    const logEvents = logFiles.reduce((n, fp) => n + db.prepare("SELECT count(*) AS c FROM events WHERE path=?").get(fp).c, 0);
    const logGaps = logFiles.reduce((n, fp) => n + db.prepare("SELECT count(*) AS c FROM index_gaps WHERE path=?").get(fp).c, 0);
    requireGuard("LOG_RAW_ONLY", logCheckpointed === 0 && logEvents === 0 && logGaps === 0 && stats.parseErrors === 0,
      `files=${logCheckpointed} events=${logEvents} gaps=${logGaps} parseErrors=${stats.parseErrors}`);

    const compactedGaps = db.prepare("SELECT count(*) AS c FROM index_gaps WHERE path=?").get(compactedFile).c;
    const compactedEvents = db.prepare("SELECT text,line FROM events WHERE path=? ORDER BY line").all(compactedFile);
    requireGuard("COMPACTED_NO_GAP", compactedGaps === 0 &&
      compactedEvents.length === 2 && compactedEvents[0].text === "guard-before-compacted" && compactedEvents[0].line === 2 &&
      compactedEvents[1].text === "guard-after-compacted" && compactedEvents[1].line === 4,
      `gaps=${compactedGaps} events=${json(compactedEvents)}`);

    const oversizedGaps = db.prepare("SELECT line,kind FROM index_gaps WHERE path=?").all(oversizedFile);
    requireGuard("OVERSIZED_NEGATIVE_CONTROL",
      oversizedGaps.length === 1 && oversizedGaps[0].kind === "oversized-line" && oversizedGaps[0].line === 1,
      `gaps=${json(oversizedGaps)}`);
    requireGuard("SCANNER_RESUMED",
      db.prepare("SELECT line FROM events WHERE path=? AND text='guard-after-real-oversized'").get(oversizedFile)?.line === 2,
      "post-oversized control was not indexed at line 2");

    const changed = fixtures.filter((fp) => shaFile(fp) !== beforeHashes.get(fp));
    requireGuard("ARCHIVE_BYTES_UNCHANGED", changed.length === 0, `changed=${changed.length}`);
    const quick = db.prepare("PRAGMA quick_check").all();
    requireGuard("DB_QUICK_CHECK", quick.length === 1 && Object.values(quick[0])[0] === "ok", `rows=${json(quick)}`);
    const events = db.prepare("SELECT count(*) AS c FROM events").get().c;
    const fts = db.prepare("SELECT count(*) AS c FROM events_fts_docsize").get().c;
    requireGuard("FTS_ROW_COUNT", events > 0 && fts === events, `events=${events} fts=${fts}`);
    const version = db.prepare("SELECT v FROM meta WHERE k='parserVersion'").get()?.v;
    requireGuard("PARSER_VERSION_CURRENT", PARSER_VERSION === "4" && version === PARSER_VERSION,
      `source=${PARSER_VERSION} db=${version}`);
    assert.deepEqual(dbmod.gapSummary(db), { "oversized-line": 1 });
    console.log("GUARD_PASS false-corruption-classes=2 deliberate-oversized-gaps=1");
  } finally {
    try { db?.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  if (error instanceof GuardError) console.error(`GUARD_FAIL ${error.label}: ${error.message}`);
  else console.error(`GUARD_FAIL INTERNAL: ${String(error?.message ?? error).slice(0, 240)}`);
  process.exitCode = 1;
});
