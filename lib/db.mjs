// lib/db.mjs — SQLite FTS index over the archive. The archive is canonical;
// this index is a disposable projection (delete recall.sqlite to rebuild).
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ARCHIVE, STATE, DB_PATH, MAX_TEXT, PARSER_VERSION } from "./paths.mjs";

const MAX_JSON = 8 * 1024 * 1024;  // whole-file *.json parse bound
const MAX_LINE = 16 * 1024 * 1024; // single-line carry bound; longer lines are dropped as gaps
// Only structured transcript generations belong in the JSON parser. The
// archive also preserves *.log artifacts (terminal output and diagnostic
// logs from Grok/Kimi) for --raw search, but treating every log line as JSON
// creates a false permanent-gap/corruption signal. Never match *.partial,
// tmp/candidate names, or non-file entries. Capture = sequence.
const INDEX_GEN_RE = /^g(\d{4,})\.(?:jsonl|ndjson|json)$/;

// Codex `compacted` envelopes can exceed MAX_LINE because replacement_history
// embeds prior context. parseRecord intentionally emits nothing for them, so
// recognize the stable top-level envelope prefix without buffering/parsing the
// giant payload. This is deliberately narrow: any other oversized record stays
// a reported coverage gap.
function isIgnorableOversizedRecord(parts) {
  const MAX_PREFIX = 1024;
  let prefix;
  if (Buffer.isBuffer(parts)) prefix = parts.subarray(0, MAX_PREFIX);
  else {
    const chunks = [];
    let left = MAX_PREFIX;
    for (const part of parts) {
      if (left <= 0) break;
      chunks.push(part.subarray(0, left));
      left -= Math.min(part.length, left);
    }
    prefix = Buffer.concat(chunks);
  }
  return /^\s*\{\s*"timestamp"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*"type"\s*:\s*"compacted"\s*,\s*"payload"\s*:/.test(prefix.toString("utf8"));
}

export function dbOpen() {
  fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, size INT, mtime REAL, offset INT, line INT);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, source TEXT, session TEXT, project TEXT,
      ts TEXT, role TEXT, kind TEXT, tool TEXT, weight REAL, opener INT, text TEXT, path TEXT, line INT);
    CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS index_gaps(path TEXT, line INT, kind TEXT, detail TEXT, PRIMARY KEY(path,line,kind));
    CREATE INDEX IF NOT EXISTS events_path ON events(path);
    CREATE INDEX IF NOT EXISTS events_source ON events(source);
    CREATE INDEX IF NOT EXISTS events_session ON events(session);
    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(text, content='events', content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS ev_ai AFTER INSERT ON events BEGIN
      INSERT INTO events_fts(rowid, text) VALUES (new.id, new.text); END;
    CREATE TRIGGER IF NOT EXISTS ev_ad AFTER DELETE ON events BEGIN
      INSERT INTO events_fts(events_fts, rowid, text) VALUES('delete', old.id, old.text); END;`);
  return db;
}

// --- persistent index gaps (the "degraded ≠ no history" ledger) ---
// detail must NEVER contain archived content; error messages are cut at the
// first double-quote (Node's JSON.parse errors quote the offending text).
const reason = (e) => String(e?.message ?? e ?? "").split('"')[0].slice(0, 120);

export function recordGap(db, { path: p, line = 0, kind, detail = "" }) {
  db.prepare(`INSERT INTO index_gaps(path,line,kind,detail) VALUES(?,?,?,?)
    ON CONFLICT(path,line,kind) DO UPDATE SET detail=excluded.detail`)
    .run(String(p ?? ""), Number(line) || 0, String(kind ?? ""), String(detail ?? "").slice(0, 120));
}

export const gapCount = (db) => db.prepare("SELECT count(*) AS c FROM index_gaps").get().c;

export function gapSummary(db) {
  const out = {};
  for (const r of db.prepare("SELECT kind, count(*) AS c FROM index_gaps GROUP BY kind ORDER BY c DESC, kind").all())
    out[r.kind] = r.c;
  return out;
}

const listDirs = (d) => {
  try {
    return fs.readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch { return []; }
};

// Indexable committed generations in a dir, in numeric generation order.
// Preserved raw-only artifacts such as *.log are intentionally absent.
const listGens = (d) => {
  try {
    return fs.readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isFile() && INDEX_GEN_RE.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => Number(a.match(INDEX_GEN_RE)[1]) - Number(b.match(INDEX_GEN_RE)[1]) || (a < b ? -1 : a > b ? 1 : 0));
  } catch { return []; }
};

// Recover session/cwd context from a file's header record when resuming at a
// byte offset (header records live on line 1: pi {type:'session'}, codex
// session_meta). Best-effort; falls back to parsers.sessionOf per record.
function headerContext(fp, parsers) {
  try {
    const fd = fs.openSync(fp, "r");
    try {
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const nl = buf.subarray(0, Math.max(n, 0)).indexOf(10);
      if (nl <= 0) return {};
      return parsers.fileContext(JSON.parse(buf.subarray(0, nl).toString("utf8")), {}) || {};
    } finally { fs.closeSync(fd); }
  } catch { return {}; }
}

// Index one generation. Per-file counters (fc) merge into stats only after a
// successful COMMIT; a failed transaction counts as one fileError, never as
// parseErrors, and leaves stats/checkpoint/gaps untouched (ROLLBACK).
// `finalized` = this gen is not the newest in its dir: a valid JSON tail
// without a trailing newline is parsed as the final line.
// `deadline()` is checked after every read chunk; when it trips, the complete
// lines so far are committed (mid-file checkpoint) and budgetHit is set.
function indexOneFile({ db, parsers, stats, source, fp, rel, relDir, prev, st, stmts, finalized, deadline }) {
  const isJson = fp.endsWith(".json");
  let offset = prev?.offset || 0, lineNo = prev?.line || 0;
  const fc = { events: 0, parseErrors: 0, truncated: 0 };
  const merge = () => {
    stats.events += fc.events; stats.parseErrors += fc.parseErrors; stats.truncated += fc.truncated;
    const bs = (stats.bySource[source] ??= { events: 0, parseErrors: 0 });
    bs.events += fc.events; bs.parseErrors += fc.parseErrors;
  };
  const gap = (line, kind, detail) => stmts.insG.run(fp, line || 0, kind, String(detail ?? "").slice(0, 120));

  db.exec("BEGIN IMMEDIATE");
  let committed = false;
  try {
    // Whole-file *.json changed: drop this path's events and reparse from 0.
    if (isJson && prev) { stmts.delE.run(fp); offset = 0; lineNo = 0; }
    // Reindex-from-0 clears the path's persistent gaps (they get re-derived);
    // a resume only clears stale unterminated-tail gaps (EOF-state only).
    if (offset === 0) stmts.delG.run(fp);
    else stmts.delGTail.run(fp);

    let openerSeen = !isJson && offset > 0 ? !!stmts.hasOpener.get(fp) : false;
    let ctx = !isJson && offset > 0 ? headerContext(fp, parsers) : {};

    const emit = (obj, ln) => {
      ctx = parsers.fileContext(obj, ctx) || ctx;
      const session = String(ctx.session || parsers.sessionOf(obj, fp, rel) || "");
      const project = String(parsers.projectOf(obj, source, relDir, ctx.cwd || "") || "");
      const ts = String(parsers.tsOf(obj) || "");
      for (const ev of parsers.parseRecord(obj)) {
        let text = String(ev.text ?? "");
        if (text.length > MAX_TEXT) { text = text.slice(0, MAX_TEXT); fc.truncated++; }
        if (!text.trim()) continue;
        const opener = !openerSeen && ev.role === "user" && ev.kind === "message" ? 1 : 0;
        if (opener) openerSeen = true;
        const weight = Number(parsers.eventWeight({ role: ev.role, kind: ev.kind, opener, text })) || 0;
        stmts.insE.run(source, session, project, ts, String(ev.role ?? "").slice(0, 32),
          String(ev.kind ?? "other").slice(0, 16), String(ev.tool ?? "").slice(0, 64),
          weight, opener, text, fp, ln);
        fc.events++;
      }
    };

    if (isJson) {
      // Pretty-printed whole-file JSON: parse the entire (bounded) buffer.
      if (st.size > MAX_JSON) {
        fc.truncated++;
        gap(0, "whole-json", `file exceeds ${MAX_JSON}-byte whole-JSON bound`);
      } else {
        let recs = null;
        try { recs = parsers.parseWholeJson(fs.readFileSync(fp)); }
        catch (e) { fc.parseErrors++; gap(0, "whole-json", reason(e)); }
        if (recs) for (const obj of recs) {
          lineNo++;
          try { emit(obj, lineNo); }
          catch (e) { fc.parseErrors++; gap(lineNo, "json-parse", reason(e)); }
        }
      }
      stmts.upF.run(fp, st.size, st.mtimeMs, st.size, lineNo);
    } else {
      // JSONL: bounded segmented scan from the checkpointed byte offset.
      // Reads are capped at the stat-snapshot size; the cross-chunk carry is
      // capped at MAX_LINE — oversized content is dropped until the next
      // newline (persistent 'oversized-line' gap), so RSS stays bounded.
      const fd = fs.openSync(fp, "r");
      try {
        const buf = Buffer.alloc(1 << 20);
        let pos = offset, lastEnd = offset;      // lastEnd = exact end of last complete line
        let carry = [], carryLen = 0, dropping = false;
        while (pos < st.size) {
          const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - pos), pos);
          if (n <= 0) break;
          const chunkStart = pos;
          pos += n;
          const seg = buf.subarray(0, n);
          let from = 0;
          while (from < n) {
            const nl = seg.indexOf(10, from);
            if (nl === -1) {
              if (!dropping) {
                carry.push(Buffer.from(seg.subarray(from)));
                carryLen += n - from;
                if (carryLen > MAX_LINE) {       // line in progress is oversized: drop it
                  if (!isIgnorableOversizedRecord(carry)) {
                    gap(lineNo + 1, "oversized-line", `line exceeds ${MAX_LINE} bytes`);
                    fc.truncated++;
                  }
                  carry = []; carryLen = 0; dropping = true;
                }
              }
              break;
            }
            lineNo++;
            if (dropping) {
              dropping = false;                  // oversized line ended; gap already recorded
            } else {
              const lineBuf = carry.length ? Buffer.concat([...carry, seg.subarray(from, nl)]) : seg.subarray(from, nl);
              carry = []; carryLen = 0;
              if (lineBuf.length > MAX_LINE) {
                if (!isIgnorableOversizedRecord(lineBuf)) {
                  gap(lineNo, "oversized-line", `line exceeds ${MAX_LINE} bytes`);
                  fc.truncated++;
                }
              } else {
                const s = lineBuf.toString("utf8").trim();
                if (s) {
                  let obj;
                  try { obj = JSON.parse(s); }
                  catch (e) { fc.parseErrors++; gap(lineNo, "json-parse", reason(e)); obj = undefined; }
                  if (obj !== undefined) {
                    try { emit(obj, lineNo); }
                    catch (e) { fc.parseErrors++; gap(lineNo, "json-parse", reason(e)); }
                  }
                }
              }
            }
            lastEnd = chunkStart + nl + 1;
            from = nl + 1;
          }
          if (deadline && deadline()) {
            // Mid-file checkpoint: commit the complete lines scanned so far in
            // the same transaction, then stop. Next run resumes at lastEnd.
            stmts.upF.run(fp, st.size, st.mtimeMs, lastEnd, lineNo);
            db.exec("COMMIT"); committed = true;
            merge();
            stats.budgetHit = true;
            return;
          }
        }
        // EOF at the stat snapshot with a pending unterminated tail.
        if ((carryLen > 0 || dropping) && !dropping) {
          const tail = Buffer.concat(carry).toString("utf8").trim();
          if (!tail) {
            lastEnd = pos;                        // whitespace-only tail: consume it
          } else if (finalized) {
            let obj;
            try { obj = JSON.parse(tail); }
            catch { obj = undefined; gap(lineNo + 1, "unterminated-tail", "finalized gen tail lacks newline; not valid JSON"); }
            if (obj !== undefined) {
              lineNo++;
              try { emit(obj, lineNo); }
              catch (e) { fc.parseErrors++; gap(lineNo, "json-parse", reason(e)); }
              lastEnd = pos;                      // tail fully consumed
            }
          } else {
            // Newest gen: the tail stays pending (may still be appended to)
            // and is reported as a persistent gap until it terminates.
            gap(lineNo + 1, "unterminated-tail", `${carryLen} tail bytes pending newline`);
          }
        }
        stmts.upF.run(fp, st.size, st.mtimeMs, lastEnd, lineNo);
      } finally { fs.closeSync(fd); }
    }
    db.exec("COMMIT"); committed = true;
    merge();
  } catch {
    if (!committed) { try { db.exec("ROLLBACK"); } catch {} }
    stats.fileErrors++;                           // txn failure ≠ parse error; fc discarded
  }
}

export async function indexAll(db, { budgetMs = 120000, parsers = null, _deadline = null } = {}) {
  if (!parsers) parsers = await import("./parsers.mjs");
  const t0 = Date.now();
  const deadline = _deadline || (() => Date.now() - t0 > budgetMs);
  const stats = {
    files: 0, events: 0, parseErrors: 0, truncated: 0, reset: 0,
    fileErrors: 0, mutated: 0, budgetHit: false, bySource: {},
  };
  const stmts = {
    selF: db.prepare("SELECT size, mtime, offset, line FROM files WHERE path=?"),
    upF: db.prepare(`INSERT INTO files(path,size,mtime,offset,line) VALUES(?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, offset=excluded.offset, line=excluded.line`),
    insE: db.prepare(`INSERT INTO events(source,session,project,ts,role,kind,tool,weight,opener,text,path,line)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`),
    delE: db.prepare("DELETE FROM events WHERE path=?"),
    hasOpener: db.prepare("SELECT 1 FROM events WHERE path=? AND opener=1 LIMIT 1"),
    insG: db.prepare(`INSERT INTO index_gaps(path,line,kind,detail) VALUES(?,?,?,?)
      ON CONFLICT(path,line,kind) DO UPDATE SET detail=excluded.detail`),
    delG: db.prepare("DELETE FROM index_gaps WHERE path=?"),
    delGTail: db.prepare("DELETE FROM index_gaps WHERE path=? AND kind='unterminated-tail'"),
    selGTail: db.prepare("SELECT 1 FROM index_gaps WHERE path=? AND kind='unterminated-tail' LIMIT 1"),
  };

  walk: for (const source of listDirs(ARCHIVE)) {
    const srcDir = path.join(ARCHIVE, source);
    for (const key of listDirs(srcDir)) {
      const dir = path.join(srcDir, key);
      let rel = "";
      try { rel = fs.readFileSync(path.join(dir, "relpath.txt"), "utf8").trim(); } catch {}
      const relDir = path.dirname(rel);
      const gens = listGens(dir);
      for (let i = 0; i < gens.length; i++) {
        if (deadline()) { stats.budgetHit = true; break walk; }
        const finalized = i < gens.length - 1;    // every gen but the newest is immutable
        const fp = path.join(dir, gens[i]);
        let st;
        try { st = fs.statSync(fp); } catch { continue; }
        const prev = stmts.selF.get(fp);
        if (prev && st.size < prev.size) {
          // An archived generation can never shrink: this is archive
          // corruption, not a reset. Keep the indexed events, record a
          // persistent gap, skip the file. Rebuild only via explicit admin op.
          stats.mutated++;
          recordGap(db, {
            path: fp, line: 0, kind: "archive-mutated",
            detail: `generation shrank ${prev.size} -> ${st.size} bytes (indexed offset ${prev.offset})`,
          });
          continue;
        }
        if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) {
          if (prev.offset >= st.size) continue;   // truly unchanged: offset check closes B5
          // offset < size on an unchanged file is either a known newline-less
          // tail (scanner recorded the gap at EOF) or an incomplete scan
          // (mid-file budget checkpoint) that must resume.
          if (!finalized && stmts.selGTail.get(fp)) {
            // Newest gen with an unterminated tail: pending + reported.
            recordGap(db, {
              path: fp, line: (prev.line || 0) + 1, kind: "unterminated-tail",
              detail: `${st.size - prev.offset} tail bytes pending newline`,
            });
            continue;
          }
          // finalized gen tail (parse it) or budget-interrupted scan (resume)
        }
        stats.files++;
        indexOneFile({ db, parsers, stats, source, fp, rel, relDir, prev, st, stmts, finalized, deadline });
        if (stats.budgetHit) break walk;
      }
    }
  }

  const setMeta = db.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v");
  setMeta.run("lastIndex", new Date().toISOString());
  setMeta.run("lastIndexStats", JSON.stringify(stats));
  return stats;
}

export function needsRebuild(db) {
  return db.prepare("SELECT v FROM meta WHERE k='parserVersion'").get()?.v !== PARSER_VERSION;
}

export function rebuild(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM events; DELETE FROM files; DELETE FROM index_gaps; DELETE FROM meta WHERE k='lastIndexStats';");
    db.prepare("INSERT INTO meta(k,v) VALUES('parserVersion',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
      .run(PARSER_VERSION);
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
}

export function eventCounts(db) {
  const out = {};
  for (const r of db.prepare(
    "SELECT source, COUNT(*) AS events, COUNT(DISTINCT session) AS sessions FROM events GROUP BY source"
  ).all()) out[r.source] = { events: r.events, sessions: r.sessions };
  return out;
}
