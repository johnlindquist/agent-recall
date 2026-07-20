// Curated memory: one fact per markdown file under MEMORY.
// Files are append-only history — status changes are the ONLY permitted
// mutation; fact bodies are never rewritten and files are never deleted.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { MEMORY, sha } from "./paths.mjs";

const MAX_FACT = 8000;

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export function projectKey(cwd = process.cwd()) {
  let top = cwd;
  try {
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 1000,
    }).toString().trim() || cwd;
  } catch {}
  const munged = top.replace(/[/.]/g, "-");   // claude style: -Users-jane-myapp
  return {
    top,
    // claude single-hyphen and pi historical double-trailing-hyphen variants
    list: [top, munged, `-${munged}-`, `-${munged}--`],
    base: path.basename(top),
    // Collision-proof memory dir key: basename alone collides across
    // client-a/api vs client-b/api — disambiguate with a toplevel-path hash.
    dirKey: `${slug(path.basename(top))}-${sha(top).slice(0, 10)}`,
  };
}

// Read facts from the new hashed dir AND the legacy plain-basename dir
// (pre-migration facts stay readable; new writes go to the hashed dir only).
const factsDirs = (cwd) => {
  const pk = projectKey(cwd);
  return [
    path.join(MEMORY, "global/facts"),
    path.join(MEMORY, "projects", pk.dirKey, "facts"),
    path.join(MEMORY, "projects", pk.base, "facts"),
  ];
};

function parseFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2];
  }
  return { file, raw, fmRaw: m[0], fm, fact: raw.slice(m[0].length).trim() };
}

function* activeFacts(cwd) {
  for (const dir of factsDirs(cwd)) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch { continue; }
    for (const f of files) {
      const p = parseFile(path.join(dir, f));
      if (p && p.fact) yield p;
    }
  }
}

export function remember(fact, { project = false, cwd = process.cwd() } = {}) {
  fact = String(fact ?? "").trim();
  if (!fact) throw new Error("empty fact");
  if (fact.length > MAX_FACT) throw new Error(`fact exceeds ${MAX_FACT} chars`);
  let scope, dir;
  if (project) {
    const pk = projectKey(cwd);          // git subprocess only for project scope
    scope = `project:${pk.base}`;
    dir = path.join(MEMORY, "projects", pk.dirKey, "facts");
  } else {
    scope = "global";                    // global remember never touches projectKey/git
    dir = path.join(MEMORY, "global/facts");
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const baseId = `${now.replace(/[:.]/g, "-")}-${sha(fact).slice(0, 8)}`;
  // wx is the atomicity guarantee; on same-ms same-fact collision retry with a
  // random suffix (<=8 retries) instead of surfacing EEXIST to the caller.
  for (let attempt = 0; ; attempt++) {
    const id = attempt === 0 ? baseId : `${baseId}-${crypto.randomBytes(4).toString("hex")}`;
    const body = `---\nid: ${id}\ncreated: ${now}\nscope: ${scope}\nstatus: active\nprovenance: human-cli\n---\n\n${fact}\n`;
    const file = path.join(dir, id + ".md");
    try {
      fs.writeFileSync(file, body, { flag: "wx", mode: 0o600 });
      return { file, scope };
    } catch (e) {
      if (e?.code !== "EEXIST" || attempt >= 8) throw e;
    }
  }
}

export function contextFacts({ staleDays = 180, cwd = process.cwd() } = {}) {
  const out = [];
  const cutoff = Date.now() - staleDays * 86400_000;
  for (const p of activeFacts(cwd)) {
    if (/^(superseded|retracted)$/.test(p.fm.status || "")) continue;
    const created = Date.parse(p.fm.created || "");
    out.push({
      scope: p.fm.scope || "global",
      fact: p.fact,
      stale: Number.isFinite(created) && created < cutoff,
      id: p.fm.id || path.basename(p.file, ".md"),
    });
  }
  return out;
}

export function forget(match, { cwd = process.cwd() } = {}) {
  const needle = String(match ?? "").trim().toLowerCase();
  if (!needle) return { action: "none" };
  const hits = [];
  for (const p of activeFacts(cwd)) {
    if ((p.fm.status || "") !== "active") continue; // active facts only
    const id = p.fm.id || path.basename(p.file, ".md");
    if (p.fact.toLowerCase().includes(needle) || id.toLowerCase().includes(needle))
      hits.push({ ...p, id });
  }
  if (!hits.length) return { action: "none" };
  if (hits.length > 1)
    return { action: "ambiguous", candidates: hits.map((h) => ({ id: h.id, fact: h.fact.slice(0, 80) })) };
  const h = hits[0];
  // Status flip is the only mutation: edit the frontmatter block, never the body.
  const fmNew = h.fmRaw
    .replace(/^status:\s*active\s*$/m, "status: retracted")
    .replace(/\n---\n?$/, `\nretracted: ${new Date().toISOString()}\n---\n`);
  fs.writeFileSync(h.file, fmNew + h.raw.slice(h.fmRaw.length), { mode: 0o600 });
  return { action: "retracted", id: h.id };
}
