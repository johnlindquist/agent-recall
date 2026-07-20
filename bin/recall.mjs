#!/usr/bin/env node
// agent-recall CLI: index (FTS5) + search/show + curated memory + doctor + self-test.
// The archive (see archive.mjs) is canonical; this index is a disposable projection.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const HOME = os.homedir();
const ROOT = process.env.RECALL_HOME || path.join(HOME, "Library/Application Support/AgentRecall");
const ARCHIVE = path.join(ROOT, "archive");
const STATE = path.join(ROOT, "state");
const MEMORY = path.join(ROOT, "memory");
const BIN = path.join(ROOT, "bin");
const DB_PATH = path.join(STATE, "recall.sqlite");
const MANIFEST = path.join(STATE, "archive-manifest.json");
const LAST = path.join(STATE, "last-search.json");
const MAX_TEXT = 32 * 1024;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const clean = (s) => String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ");

// ---------- db ----------
function dbOpen() {
  fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, size INT, mtime REAL, offset INT, line INT);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, source TEXT, session TEXT, project TEXT,
      ts TEXT, role TEXT, kind TEXT, tool TEXT, text TEXT, path TEXT, line INT);
    CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(text, content='events', content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS ev_ai AFTER INSERT ON events BEGIN
      INSERT INTO events_fts(rowid, text) VALUES (new.id, new.text); END;
    CREATE TRIGGER IF NOT EXISTS ev_ad AFTER DELETE ON events BEGIN
      INSERT INTO events_fts(events_fts, rowid, text) VALUES('delete', old.id, old.text); END;`);
  return db;
}

// ---------- parsing ----------
const SKIP_KEYS = new Set(["thinking", "reasoning", "signature", "encrypted", "encrypted_content", "system", "systemPrompt"]);
const TEXT_KEYS = ["text", "content", "message", "prompt", "response", "output", "input", "body", "value", "arguments", "result"];

function textFrom(v, depth = 0, out = []) {
  if (depth > 4 || out.length > 20) return out;
  if (typeof v === "string") { if (v.trim()) out.push(v); return out; }
  if (Array.isArray(v)) { for (const x of v) textFrom(x, depth + 1, out); return out; }
  if (v && typeof v === "object") {
    for (const k of TEXT_KEYS) if (k in v && !SKIP_KEYS.has(k)) textFrom(v[k], depth + 1, out);
  }
  return out;
}

function* parseRecord(obj) {
  const t = obj.type || obj.role || "";
  if (SKIP_KEYS.has(t)) return;
  const msg = obj.message && typeof obj.message === "object" ? obj.message : obj;
  const role = msg.role || obj.type || obj.role || "";
  const content = msg.content ?? msg.text ?? obj.content ?? obj.text;
  let emitted = false;
  if (typeof content === "string" && content.trim()) { emitted = true; yield { role, kind: "message", tool: "", text: content }; }
  else if (Array.isArray(content)) {
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      if (c.type === "text" && c.text?.trim()) { emitted = true; yield { role, kind: "message", tool: "", text: c.text }; }
      else if (c.type === "thinking" || c.type === "reasoning") continue;
      else if (c.type === "tool_use" || c.type === "tool_call") {
        emitted = true;
        yield { role, kind: "tool", tool: c.name || "", text: JSON.stringify(c.input ?? c.arguments ?? "") };
      } else if (c.type === "tool_result") {
        emitted = true;
        yield { role, kind: "tool_result", tool: "", text: textFrom(c.content).join("\n") || JSON.stringify(c.content ?? "") };
      }
    }
  }
  if (obj.type === "function_call" || obj.type === "tool_call") {
    emitted = true;
    yield { role: "assistant", kind: "tool", tool: obj.name || obj.function || "", text: String(obj.arguments ?? JSON.stringify(obj.input ?? "")) };
  }
  if (!emitted) {
    const texts = textFrom(obj);
    if (texts.length) yield { role, kind: "other", tool: "", text: texts.join("\n") };
  }
}

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
function sessionOf(obj, filePath) {
  return obj.sessionId || obj.session_id || (obj.type === "session" && obj.id) ||
    (path.basename(filePath).match(UUID_RE) || [])[1] || path.basename(filePath).replace(/\.[^.]+$/, "");
}
function tsOf(obj) {
  const v = obj.timestamp || obj.ts || obj.created_at || obj.createdAt || obj.time || "";
  if (typeof v === "number") return new Date(v > 1e12 ? v : v * 1000).toISOString();
  return typeof v === "string" ? v : "";
}
function projectOf(obj, source, relDir) {
  if (typeof obj.cwd === "string" && obj.cwd) return obj.cwd;
  if (source.startsWith("claude") || source === "pi") return relDir.split(path.sep)[0] || "";
  return "";
}

// ---------- indexing ----------
function indexAll(db) {
  const lock = path.join(STATE, "index.lock");
  try { fs.mkdirSync(lock); } catch {
    try { if (Date.now() - fs.statSync(lock).mtimeMs > 180000) { fs.rmSync(lock, { recursive: true, force: true }); fs.mkdirSync(lock); } else return { skipped: true }; }
    catch { return { skipped: true }; }
  }
  const stats = { files: 0, events: 0, parseErrors: 0, truncated: 0, reset: 0 };
  const t0 = Date.now();
  try {
    const selF = db.prepare("SELECT size, mtime, offset, line FROM files WHERE path=?");
    const upF = db.prepare("INSERT INTO files(path,size,mtime,offset,line) VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, offset=excluded.offset, line=excluded.line");
    const insE = db.prepare("INSERT INTO events(source,session,project,ts,role,kind,tool,text,path,line) VALUES(?,?,?,?,?,?,?,?,?,?)");
    const delE = db.prepare("DELETE FROM events WHERE path=?");

    for (const source of fs.existsSync(ARCHIVE) ? fs.readdirSync(ARCHIVE) : []) {
      const srcDir = path.join(ARCHIVE, source);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      for (const key of fs.readdirSync(srcDir)) {
        const dir = path.join(srcDir, key);
        let rel = ""; try { rel = fs.readFileSync(path.join(dir, "relpath.txt"), "utf8").trim(); } catch {}
        const relDir = path.dirname(rel);
        for (const gen of fs.readdirSync(dir).filter((f) => f.startsWith("g")).sort()) {
          if (Date.now() - t0 > 120000) return { ...stats, budgetHit: true };
          const fp = path.join(dir, gen);
          const st = fs.statSync(fp);
          const prev = selF.get(fp);
          if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) continue;
          let offset = prev?.offset || 0, lineNo = prev?.line || 0;
          if (prev && st.size < prev.size) { delE.run(fp); offset = 0; lineNo = 0; stats.reset++; }
          stats.files++;
          const fd = fs.openSync(fp, "r");
          let carry = Buffer.alloc(0);
          db.exec("BEGIN IMMEDIATE");
          try {
            const buf = Buffer.alloc(1024 * 1024);
            let pos = offset;
            while (pos < st.size) {
              const n = fs.readSync(fd, buf, 0, buf.length, pos);
              if (n <= 0) break;
              pos += n;
              let chunk = Buffer.concat([carry, buf.subarray(0, n)]);
              let idx;
              while ((idx = chunk.indexOf(10)) !== -1) {
                const lineBuf = chunk.subarray(0, idx);
                chunk = chunk.subarray(idx + 1);
                lineNo++;
                offset += lineBuf.length + 1 + (carry.length ? 0 : 0);
                const line = lineBuf.toString("utf8").trim();
                if (!line) continue;
                if (line.length > 16 * 1024 * 1024) { stats.truncated++; continue; }
                let obj;
                try { obj = JSON.parse(line); } catch { stats.parseErrors++; continue; }
                const session = sessionOf(obj, rel || fp);
                const ts = tsOf(obj);
                const project = projectOf(obj, source, relDir);
                for (const ev of parseRecord(obj)) {
                  let text = clean(ev.text);
                  if (text.length > MAX_TEXT) { text = text.slice(0, MAX_TEXT); stats.truncated++; }
                  if (!text.trim()) continue;
                  insE.run(source, String(session), String(project), ts, String(ev.role).slice(0, 32), ev.kind, String(ev.tool).slice(0, 64), text, fp, lineNo);
                  stats.events++;
                }
              }
              carry = chunk;
            }
            // do not index a trailing partial line; resume there next run
            upF.run(fp, st.size, st.mtimeMs, st.size - carry.length, lineNo);
            db.exec("COMMIT");
          } catch (e) { db.exec("ROLLBACK"); stats.parseErrors++; }
          finally { fs.closeSync(fd); }
        }
      }
    }
    db.prepare("INSERT INTO meta(k,v) VALUES('lastIndex',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(new Date().toISOString());
    db.prepare("INSERT INTO meta(k,v) VALUES('lastIndexStats',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(JSON.stringify(stats));
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
  return stats;
}

// ---------- search ----------
function manifest() { try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); } catch { return null; } }
function ageMin(iso) { return iso ? Math.round((Date.now() - Date.parse(iso)) / 60000) : null; }

function healthBanner(db) {
  const m = manifest();
  const archAge = ageMin(m?.lastRun?.at);
  const idxIso = db.prepare("SELECT v FROM meta WHERE k='lastIndex'").get()?.v;
  const idxAge = ageMin(idxIso);
  const stats = JSON.parse(db.prepare("SELECT v FROM meta WHERE k='lastIndexStats'").get()?.v || "{}");
  const gaps = [];
  if (archAge === null) gaps.push("no archive run yet");
  else if (archAge > 24 * 60) gaps.push(`archive STALE (${Math.round(archAge / 60)}h old)`);
  if (stats.parseErrors > 0) gaps.push(`${stats.parseErrors} unparsed lines (rg fallback: recall search --raw)`);
  if (m?.lastRun?.counts?.storageSkipped) gaps.push(`${m.lastRun.counts.storageSkipped} files skipped (budget)`);
  if (m?.lastRun?.monitor?.agy > 0) gaps.push(`antigravity: ${m.lastRun.monitor.agy} conversations NOT yet archived (lane disabled)`);
  return { archAge, idxAge, gaps, status: gaps.some((g) => g.includes("STALE")) ? "degraded" : "ok" };
}

function projectVariants(cwd) {
  let top = cwd;
  try { top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
  const munged = top.replace(/[/.]/g, "-");        // claude style: -Users-jane-myapp
  const piMunged = `-${munged}-`;                  // pi style: --Users-jane-myapp--
  return { top, list: [top, munged, piMunged], base: path.basename(top) };
}

function ftsExpr(q) {
  const toks = q.match(/[A-Za-z0-9_./@-]+/g) || [];
  return toks.map((t) => `"${t.replace(/"/g, "")}"`).join(" AND ");
}

const RESUME = {
  "claude-primary": (s) => `claude --resume ${s}`,
  "claude-second": (s) => `CLAUDE_CONFIG_DIR="$HOME/.claude-second" claude --resume ${s}`,
  "codex-active": (s) => `codex resume ${s}`,
  "codex-archived": (s) => `codex resume ${s}`,
  grok: (s) => `grok --resume ${s}  # unverified`,
  "kimi-code": (s) => `kimi  # then /resume ${s} (unverified)`,
  "kimi-legacy": (s) => `kimi  # legacy store (unverified)`,
  pi: (s) => `pi --session ${s}`,
  selftest: () => "",
};

function search(args) {
  const json = args.includes("--json");
  const all = args.includes("--all");
  const raw = args.includes("--raw");
  const srcFilter = args.includes("--source") ? args[args.indexOf("--source") + 1] : null;
  const q = args.filter((a) => !a.startsWith("--") && a !== srcFilter).join(" ").trim();
  if (!q) { console.error("usage: recall search <words> [--all] [--json] [--raw] [--source NAME]"); process.exit(64); }

  if (raw) {
    const r = spawnSync("rg", ["-i", "--max-count", "3", "-C", "1", q, ARCHIVE], { encoding: "utf8" });
    process.stdout.write(clean(r.stdout || "").split("\n").slice(0, 120).join("\n") + "\n");
    if (r.status !== 0 && !r.stdout) console.log("(no raw matches)");
    return;
  }

  const db = dbOpen();
  const h = healthBanner(db);
  const pv = projectVariants(process.cwd());
  const expr = ftsExpr(q);
  if (!expr) { console.error("no searchable terms"); process.exit(64); }
  let sql = `SELECT e.id, e.source, e.session, e.project, e.ts, e.role, e.kind, e.tool, e.path, e.line,
      snippet(events_fts, 0, '', '', '…', 24) AS snip
    FROM events_fts JOIN events e ON e.id = events_fts.rowid
    WHERE events_fts MATCH ?`;
  const params = [expr];
  if (srcFilter) { sql += " AND e.source = ?"; params.push(srcFilter); }
  if (!all) {
    sql += ` AND (e.project = '' OR e.project IN (?,?,?) OR e.project LIKE ?)`;
    params.push(...pv.list, `%${pv.base}%`);
  }
  sql += " ORDER BY bm25(events_fts) LIMIT 40";
  let rows = [];
  try { rows = db.prepare(sql).all(...params); } catch (e) { console.error("index error (try --raw):", e.message); process.exit(1); }

  // collapse exact duplicates (same session+text hash), keep first
  const seen = new Set(); const hits = [];
  for (const r of rows) {
    const k = `${r.session}\0${sha(r.snip).slice(0, 12)}`;
    if (seen.has(k)) continue; seen.add(k);
    hits.push(r);
    if (hits.length >= 12) break;
  }
  fs.writeFileSync(LAST, JSON.stringify({ q, at: new Date().toISOString(), hits }), { mode: 0o600 });

  if (json) { console.log(JSON.stringify({ query: q, health: h, hits: hits.map((r, i) => ({ n: i + 1, ...r, resume: (RESUME[r.source] || (() => ""))(r.session) })) })); return; }
  const head = `recall: archive ${h.archAge ?? "?"}m · index ${h.idxAge ?? "?"}m${h.gaps.length ? " · GAPS: " + h.gaps.join("; ") : ""}`;
  console.log(head);
  if (!hits.length) {
    console.log(h.status === "ok" ? `no indexed matches for "${q}" (coverage above; try --all or --raw)` : `no matches — but coverage is DEGRADED, do not conclude "no history". Try --raw.`);
    return;
  }
  for (const [i, r] of hits.entries()) {
    const d = (r.ts || "").slice(0, 10) || "????-??-??";
    const proj = r.project ? ` ${path.basename(String(r.project)).slice(0, 24)}` : "";
    console.log(`\n[${i + 1}] ${r.source} ${d}${proj} ${r.role}${r.tool ? ` tool:${r.tool}` : ""}`);
    console.log(`    ${clean(r.snip).slice(0, 300)}`);
    const cmd = (RESUME[r.source] || (() => ""))(r.session);
    if (cmd) console.log(`    ↩ ${cmd}`);
  }
  console.log(`\n(recall show <n> for context · --all for every project · --raw for grep lane)`);
}

function show(args) {
  const n = Number(args[0] || 0);
  let last; try { last = JSON.parse(fs.readFileSync(LAST, "utf8")); } catch { console.error("no previous search"); process.exit(1); }
  const hit = last.hits[n - 1];
  if (!hit) { console.error(`no hit #${n}`); process.exit(1); }
  const lines = fs.readFileSync(hit.path, "utf8").split("\n");
  const lo = Math.max(0, hit.line - 4), hi = Math.min(lines.length, hit.line + 3);
  console.log(`# ${hit.source} session ${hit.session} (${hit.path}:${hit.line})`);
  for (let i = lo; i < hi; i++) {
    let t = lines[i];
    try { const o = JSON.parse(t); t = [...parseRecord(o)].map((e) => `${e.role}${e.tool ? `(${e.tool})` : ""}: ${e.text.slice(0, 500)}`).join("\n") || t.slice(0, 200); } catch { t = t.slice(0, 200); }
    console.log(clean(t).slice(0, 2000));
  }
  const cmd = (RESUME[hit.source] || (() => ""))(hit.session);
  if (cmd) console.log(`\n↩ resume: ${cmd}`);
}

// ---------- memory ----------
function factsDirs(projectOnly) {
  const pv = projectVariants(process.cwd());
  const dirs = [];
  if (!projectOnly) dirs.push(path.join(MEMORY, "global/facts"));
  dirs.push(path.join(MEMORY, "projects", pv.base, "facts"));
  return dirs;
}
function remember(args) {
  const project = args.includes("--project");
  const fact = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!fact || fact.length > 8000) { console.error("usage: recall remember \"<one durable fact>\" [--project]"); process.exit(64); }
  const pv = projectVariants(process.cwd());
  const dir = project ? path.join(MEMORY, "projects", pv.base, "facts") : path.join(MEMORY, "global/facts");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${sha(fact).slice(0, 8)}`;
  const body = `---\nid: ${id}\ncreated: ${new Date().toISOString()}\nscope: ${project ? `project:${pv.base}` : "global"}\nstatus: active\nprovenance: human-cli\n---\n\n${fact}\n`;
  fs.writeFileSync(path.join(dir, id + ".md"), body, { flag: "wx", mode: 0o600 });
  console.log(`remembered (${project ? "project:" + pv.base : "global"}): ${fact.slice(0, 80)}`);
}
function context(args) {
  const json = args.includes("--json");
  const out = [];
  for (const dir of factsDirs(false)) {
    let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort().slice(-100); } catch { continue; }
    for (const f of files) {
      const raw = fs.readFileSync(path.join(dir, f), "utf8");
      if (/^status:\s*(superseded|retracted)/m.test(raw)) continue;
      const fact = raw.replace(/^---[\s\S]*?---\s*/m, "").trim();
      const scope = (raw.match(/^scope:\s*(.+)$/m) || [])[1] || "global";
      if (fact) out.push({ scope, fact });
    }
  }
  if (json) console.log(JSON.stringify(out));
  else if (!out.length) console.log("(no stored facts yet — add with: recall remember \"...\")");
  else for (const o of out) console.log(`- [${o.scope}] ${o.fact.split("\n")[0].slice(0, 200)}`);
}

// ---------- doctor ----------
function doctor() {
  const checks = [];
  const ok = (name, pass, note = "") => checks.push({ name, pass, note });
  try { ok("root perms", (fs.statSync(ROOT).mode & 0o777) === 0o700, ROOT); } catch { ok("root exists", false, ROOT); }
  try { const db = dbOpen(); db.exec("SELECT 1"); ok("sqlite+fts5", true); const c = db.prepare("SELECT count(*) c FROM events").get().c; ok("indexed events", true, String(c)); } catch (e) { ok("sqlite+fts5", false, e.message); }
  const m = manifest();
  ok("archive run", !!m?.lastRun, m?.lastRun ? `${ageMin(m.lastRun.at)}m ago` : "never");
  if (m?.lastRun) {
    ok("archive fresh (<24h)", ageMin(m.lastRun.at) < 1440);
    ok("archive errors", (m.lastRun.counts?.errors || 0) === 0, String(m.lastRun.counts?.errors || 0));
    if (m.lastRun.monitor?.agy > 0) ok("antigravity lane", false, `${m.lastRun.monitor.agy} conversations present but NOT archived (snapshot lane disabled — fast-follow)`);
  }
  for (const [name, p] of [["claude-primary", "~/.claude/projects"], ["claude-second", "~/.claude-second/projects"], ["codex", "~/.codex/sessions"], ["grok", "~/.grok/sessions"], ["kimi-code", "~/.kimi-code/sessions"], ["pi", "~/.pi/agent/sessions"]]) {
    ok(`source ${name}`, fs.existsSync(p.replace("~", HOME)), p);
  }
  for (const [name, f] of [["claude-primary retention", path.join(HOME, ".claude/settings.json")], ["claude-second retention", path.join(HOME, ".claude-second/settings.json")]]) {
    try { ok(name, JSON.parse(fs.readFileSync(f, "utf8")).cleanupPeriodDays >= 3650, f); } catch { ok(name, false, f); }
  }
  try { ok("codex save-all", /persistence\s*=\s*"save-all"/.test(fs.readFileSync(path.join(HOME, ".codex/config.toml"), "utf8"))); } catch { ok("codex save-all", false); }
  try { const r = spawnSync("launchctl", ["print", `gui/${process.getuid()}/local.agent-recall.sync`], { encoding: "utf8" }); ok("launchd job", r.status === 0); } catch { ok("launchd job", false); }
  ok("grok/kimi retention knobs", true, "unknown — TODO probes (archive is the safeguard)");
  let fail = false;
  for (const c of checks) { if (!c.pass) fail = true; console.log(`${c.pass ? "ok " : "FAIL"} ${c.name}${c.note ? ` — ${c.note}` : ""}`); }
  process.exit(fail ? 1 : 0);
}

// ---------- self-test ----------
function selfTest() {
  if (!process.env.RECALL_SELFTEST_ISOLATED) {
    // run the whole test in a throwaway RECALL_HOME so production archive,
    // manifest, index, and the launchd job are never touched or raced.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recall-selftest-"));
    const r = spawnSync(process.execPath, [process.argv[1], "self-test"], {
      stdio: "inherit",
      env: { ...process.env, RECALL_HOME: tmp, RECALL_SELFTEST_ISOLATED: "1", NODE_NO_WARNINGS: "1" },
    });
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(r.status || 0);
  }
  const dir = path.join(STATE, "selftest-source");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const A = `CANARY-A-${sha(String(Math.random())).slice(0, 10)}`;
  const B = `CANARY-B-${sha(String(Math.random())).slice(0, 10)}`;
  const TOOL = `TOOLCANARY-${sha(String(Math.random())).slice(0, 8)}`;
  const HIDDEN = `HIDDENCANARY-${sha(String(Math.random())).slice(0, 8)}`;
  const f = path.join(dir, "11111111-2222-3333-4444-555555555555.jsonl");
  fs.writeFileSync(f, [
    JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: `please find ${A}` } }),
    "{malformed",
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: TOOL } }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: HIDDEN }] } }),
  ].join("\n") + "\n");
  const archiveSrc = fs.existsSync(path.join(BIN, "archive.mjs")) ? path.join(BIN, "archive.mjs") : path.join(path.dirname(process.argv[1]), "archive.mjs");
  const env = { ...process.env, RECALL_SELFTEST_SOURCE: dir, RECALL_ONLY_SELFTEST: "1", NODE_NO_WARNINGS: "1" };
  const run = () => { const r = spawnSync(process.execPath, [archiveSrc], { env, encoding: "utf8" }); if (r.status !== 0) throw new Error("archiver failed: " + r.stderr); };
  run();
  let db = dbOpen(); indexAll(db);
  const find = (needle) => db.prepare(`SELECT count(*) c FROM events_fts WHERE events_fts MATCH ?`).get(`"${needle}"`).c;
  const assert = (name, cond) => { if (!cond) { console.error(`SELF-TEST FAIL: ${name}`); cleanup(db); process.exit(1); } console.log(`ok ${name}`); };
  assert("canary A indexed", find(A) >= 1);
  assert("tool input indexed", find(TOOL) >= 1);
  assert("hidden reasoning excluded", find(HIDDEN) === 0);
  // rewrite → new generation
  fs.writeFileSync(f, JSON.stringify({ type: "user", message: { role: "user", content: `rewritten ${B}` } }) + "\n");
  run(); indexAll(db);
  assert("rewrite canary B indexed", find(B) >= 1);
  const man = manifest();
  const entry = Object.entries(man.entries).find(([k]) => k.startsWith("selftest "));
  assert("rewrite created 2nd generation", entry && entry[1].gens.length >= 2);
  cleanup(db);
  console.log("SELF-TEST PASS");
  function cleanup(db) {
    try {
      db.prepare("DELETE FROM events WHERE source='selftest'").run();
      const paths = db.prepare("SELECT path FROM files WHERE path LIKE ?").all(`%${path.sep}selftest${path.sep}%`);
      for (const p of paths) db.prepare("DELETE FROM files WHERE path=?").run(p.path);
      const man2 = manifest();
      for (const k of Object.keys(man2.entries)) if (k.startsWith("selftest ")) delete man2.entries[k];
      fs.writeFileSync(MANIFEST, JSON.stringify(man2), { mode: 0o600 });
      fs.rmSync(path.join(ARCHIVE, "selftest"), { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

// ---------- main ----------
const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "sync": {
    const r = spawnSync(process.execPath, [path.join(BIN, "archive.mjs")], { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
    const s = indexAll(dbOpen());
    if (!args.includes("--quiet")) console.log(`sync ok · indexed ${s.events ?? 0} new events${s.parseErrors ? ` · ${s.parseErrors} unparsed lines` : ""}`);
    break;
  }
  case "archive": { const r = spawnSync(process.execPath, [path.join(BIN, "archive.mjs")], { stdio: "inherit" }); process.exit(r.status || 0); }
  case "index": { console.log(JSON.stringify(indexAll(dbOpen()))); break; }
  case "search": search(args); break;
  case "show": show(args); break;
  case "remember": remember(args); break;
  case "context": context(args); break;
  case "doctor": doctor(); break;
  case "self-test": selfTest(); break;
  default:
    console.log(`agent-recall — local cross-agent history search + shared memory
usage:
  recall search <words> [--all] [--raw] [--json] [--source NAME]
  recall show <n>            context for search hit n
  recall sync [--quiet]      archive sources + update index (launchd runs this)
  recall remember "<fact>" [--project]
  recall context [--json]    curated facts (agents: read-only)
  recall doctor              health + coverage
  recall self-test           synthetic end-to-end check`);
}
