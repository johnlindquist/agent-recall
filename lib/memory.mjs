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

function gitPath(cwd, flag) {
  const output = execFileSync("git", ["-c", "core.quotePath=false", "rev-parse", flag], {
    cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 1000,
  });
  // Git adds one record newline. Remove exactly that byte, never user path
  // whitespace (including a legitimate trailing space or embedded newline).
  const raw = output.length && output[output.length - 1] === 10
    ? output.subarray(0, output.length - 1)
    : output;
  return raw.toString("utf8");
}

export function projectKey(cwd = process.cwd()) {
  let top;
  let kind = "plain";
  let gitDir = null;
  try {
    top = gitPath(cwd, "--show-toplevel");
    gitDir = fs.realpathSync(path.resolve(cwd, gitPath(cwd, "--absolute-git-dir")));
    kind = "git";
  } catch {
    top = cwd;
  }
  top = fs.realpathSync(top);
  const stat = fs.statSync(top, { bigint: true });
  const munged = top.replace(/[/.]/g, "-");   // claude style: -Users-jane-myapp
  return {
    kind,
    top,
    gitDir,
    dev: String(stat.dev),
    ino: String(stat.ino),
    // claude single-hyphen and pi historical double-trailing-hyphen variants
    list: [top, munged, `-${munged}-`, `-${munged}--`],
    base: path.basename(top),
    // Full versioned identity: old basename/40-bit directories remain unbound
    // legacy data rather than aliasing another project.
    dirKey: `v2-${sha(top)}`,
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
  const lst = fs.lstatSync(file);
  if (!lst.isFile() || lst.isSymbolicLink()) throw new Error(`unsafe memory fact entry: ${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let raw;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 64 * 1024) throw new Error(`invalid memory fact file: ${file}`);
    raw = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) throw new Error(`malformed memory fact frontmatter: ${file}`);
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv || Object.hasOwn(fm, kv[1])) throw new Error(`malformed memory fact metadata: ${file}`);
    fm[kv[1]] = kv[2];
  }
  const allowed = new Set(["id", "created", "scope", "project_key", "status", "provenance", "retracted"]);
  if (Object.keys(fm).some((key) => !allowed.has(key)) ||
      fm.id !== path.basename(file, ".md") ||
      !/^[a-zA-Z0-9-]+$/.test(fm.id || "") ||
      !Number.isFinite(Date.parse(fm.created || "")) ||
      !new Set(["global", "project"]).has(fm.scope) ||
      (fm.scope === "project" ? !/^v2-[a-f0-9]{64}$/.test(fm.project_key || "") : fm.project_key !== undefined) ||
      !new Set(["active", "retracted", "superseded"]).has(fm.status) ||
      fm.provenance !== "human-cli")
    throw new Error(`invalid memory fact metadata: ${file}`);
  // remember() adds exactly one separator newline after the frontmatter and
  // exactly one file-terminal newline. Remove only that framing so user text,
  // including additional leading/trailing whitespace, round-trips exactly.
  let fact = raw.slice(m[0].length);
  if (fact.startsWith("\n")) fact = fact.slice(1);
  if (fact.endsWith("\n")) fact = fact.slice(0, -1);
  if (!fact.trim()) throw new Error(`empty memory fact body: ${file}`);
  return { file, raw, fmRaw: m[0], fm, fact };
}

function listFactFiles(dir) {
  let dirStat;
  try { dirStat = fs.lstatSync(dir); }
  catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink())
    throw new Error(`unsafe memory facts directory: ${dir}`);
  return fs.readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
}

const readAllFacts = (dir) => listFactFiles(dir).map((name) => parseFile(path.join(dir, name)));

function* activeFacts(cwd, { project = null } = {}) {
  const sources = factSources(cwd);
  const selected = project === true ? sources.slice(1) : project === false ? sources.slice(0, 1) : sources;
  for (const { dir, scope } of selected) {
    const facts = readAllFacts(dir);
    for (const p of facts) {
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
    const temp = path.join(dir, `.fact-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`);
    try {
      const fd = fs.openSync(temp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, Buffer.from(body, "utf8"));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      // Hard-link publication is atomic and no-clobber. A short/failed temp
      // write never becomes a visible .md fact.
      fs.linkSync(temp, file);
      fs.unlinkSync(temp);
      const dirFd = fs.openSync(dir, fs.constants.O_RDONLY);
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      if (fs.readFileSync(file, "utf8") !== body)
        throw new Error("memory fact readback mismatch");
      return { id, file, scope };
    } catch (e) {
      try { fs.unlinkSync(temp); } catch {}
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
    const facts = readAllFacts(dir);
    for (const p of facts) {
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
