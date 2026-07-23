// Curated memory: one fact per markdown file under MEMORY.
// Files are append-only history — status changes are the ONLY permitted
// mutation; fact bodies are never rewritten and files are never deleted.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { MEMORY, STATE, sha } from "./paths.mjs";
import { withOwnerLock } from "./owner-lock.mjs";

export const MAX_FACT = 8000;

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
// The suffix is one hyphen plus ten hex chars, leaving 244 ASCII bytes within
// the common 255-byte filesystem component limit while preserving every
// previously valid ordinary key.
const projectSlug = (base) => (slug(base) || "project").slice(0, 244);

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
    dirKey: `${projectSlug(path.basename(top))}-${sha(top).slice(0, 10)}`,
  };
}

// Bound project operations use only the collision-proof hashed directory.
// Legacy basename directories remain preserved on disk as unbound data; they
// cannot be silently attributed to every current project with the same name.
const factsDirsForTarget = (projectTarget) => {
  if (!projectTarget) return [path.join(MEMORY, "global/facts")];
  return [path.join(MEMORY, "projects", projectTarget.dirKey, "facts")];
};

const factSources = (cwd) => {
  const target = projectKey(cwd);
  return [
    { dir: path.join(MEMORY, "global/facts"), scope: "global" },
    {
      dir: path.join(MEMORY, "projects", target.dirKey, "facts"),
      scope: `project:${target.base}`,
    },
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
  // remember() adds exactly one separator newline after the frontmatter and
  // exactly one file-terminal newline. Remove only that framing so user text,
  // including additional leading/trailing whitespace, round-trips exactly.
  let fact = raw.slice(m[0].length);
  if (fact.startsWith("\n")) fact = fact.slice(1);
  if (fact.endsWith("\n")) fact = fact.slice(0, -1);
  return { file, raw, fmRaw: m[0], fm, fact };
}

function* activeFacts(cwd, { project = null } = {}) {
  const sources = factSources(cwd);
  const selected = project === true ? sources.slice(1) : project === false ? sources.slice(0, 1) : sources;
  for (const { dir, scope } of selected) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch { continue; }
    for (const f of files) {
      const p = parseFile(path.join(dir, f));
      if (p && p.fact) yield { ...p, logicalScope: scope };
    }
  }
}

const MEMORY_WRITE_LOCK = path.join(STATE, "memory-write.lock");

function rememberAtTargetUnlocked(fact, projectTarget = null) {
  const factText = String(fact ?? "");
  if (!factText.trim()) throw new Error("empty fact");
  if (factText.length > MAX_FACT) throw new Error(`fact exceeds ${MAX_FACT} chars`);
  let scope, dir;
  if (projectTarget) {
    scope = `project:${projectTarget.base}`;
    dir = path.join(MEMORY, "projects", projectTarget.dirKey, "facts");
  } else {
    scope = "global";
    dir = path.join(MEMORY, "global/facts");
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const baseId = `${now.replace(/[:.]/g, "-")}-${sha(factText).slice(0, 8)}`;
  // wx is the atomicity guarantee; on same-ms same-fact collision retry with a
  // random suffix (<=8 retries) instead of surfacing EEXIST to the caller.
  for (let attempt = 0; ; attempt++) {
    const id = attempt === 0 ? baseId : `${baseId}-${crypto.randomBytes(4).toString("hex")}`;
    const projectMetadata = projectTarget
      ? `scope: project\nproject_key: ${projectTarget.dirKey}\n`
      : "scope: global\n";
    const body = `---\nid: ${id}\ncreated: ${now}\n${projectMetadata}status: active\nprovenance: human-cli\n---\n\n${factText}\n`;
    const file = path.join(dir, id + ".md");
    try {
      fs.writeFileSync(file, body, { flag: "wx", mode: 0o600 });
      return { id, file, scope };
    } catch (e) {
      if (e?.code !== "EEXIST" || attempt >= 8) throw e;
    }
  }
}

function rememberUnlocked(fact, { project = false, cwd = process.cwd() } = {}) {
  return rememberAtTargetUnlocked(fact, project ? projectKey(cwd) : null);
}

export function remember(fact, options = {}) {
  return withOwnerLock(MEMORY_WRITE_LOCK, () => rememberUnlocked(fact, options));
}

export function findActiveDuplicate(fact, { project = false, cwd = process.cwd() } = {}) {
  const factText = String(fact ?? "");
  for (const p of activeFacts(cwd, { project })) {
    if ((p.fm.status || "") !== "active" || p.fact !== factText) continue;
    return {
      id: p.fm.id || path.basename(p.file, ".md"),
      file: p.file,
      scope: p.logicalScope,
      fact: p.fact,
    };
  }
  return null;
}

function findActiveDuplicateAtTarget(fact, projectTarget = null) {
  const factText = String(fact ?? "");
  for (const dir of factsDirsForTarget(projectTarget)) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch { continue; }
    for (const f of files) {
      const p = parseFile(path.join(dir, f));
      if (!p || (p.fm.status || "") !== "active" || p.fact !== factText) continue;
      return {
        id: p.fm.id || path.basename(p.file, ".md"),
        file: p.file,
        scope: projectTarget ? `project:${projectTarget.base}` : "global",
        fact: p.fact,
      };
    }
  }
  return null;
}

function rememberIfAbsentAtTarget(fact, projectTarget = null) {
  const duplicate = findActiveDuplicateAtTarget(fact, projectTarget);
  if (duplicate) return { action: "existing", ...duplicate };
  return { action: "remembered", ...rememberAtTargetUnlocked(fact, projectTarget) };
}

export function rememberIfAbsent(fact, { project = false, cwd = process.cwd() } = {}) {
  return withOwnerLock(MEMORY_WRITE_LOCK, () => {
    const projectTarget = project ? projectKey(cwd) : null;
    return rememberIfAbsentAtTarget(fact, projectTarget);
  });
}

// Acceptance needs to validate the proposal only after it owns the same lock
// that protects duplicate lookup and every write. The callback receives a
// narrow locked capability so no project identity is rediscovered mid-commit.
export function withMemoryWriteLock(fn) {
  return withOwnerLock(MEMORY_WRITE_LOCK, () => fn({
    findActiveDuplicateAtTarget,
    rememberAtTarget: rememberAtTargetUnlocked,
    rememberIfAbsentAtTarget,
  }));
}

export function contextFacts({ staleDays = 180, cwd = process.cwd() } = {}) {
  const out = [];
  const cutoff = Date.now() - staleDays * 86400_000;
  for (const p of activeFacts(cwd)) {
    if (/^(superseded|retracted)$/.test(p.fm.status || "")) continue;
    const created = Date.parse(p.fm.created || "");
    out.push({
      scope: p.logicalScope,
      fact: p.fact,
      stale: Number.isFinite(created) && created < cutoff,
      id: p.fm.id || path.basename(p.file, ".md"),
    });
  }
  return out;
}

function forgetUnlocked(match, { cwd = process.cwd() } = {}) {
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

export function forget(match, options = {}) {
  return withOwnerLock(MEMORY_WRITE_LOCK, () => forgetUnlocked(match, options));
}
