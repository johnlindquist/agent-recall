// Short-lived, agent-safe memory proposals. This module never writes curated
// memory; only the human-gated recall remember --accept path may do that.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MEMORY_PROPOSALS, STATE, sha } from "./paths.mjs";
import { MAX_FACT, projectKey } from "./memory.mjs";
import { withOwnerLock } from "./owner-lock.mjs";

export const PROPOSAL_SCHEMA_VERSION = 3;
export const PROPOSAL_TTL_MS = 30 * 60 * 1000;
export const PROPOSAL_ID_RE = /^[a-f0-9]{32}$/;
export const MAX_LIVE_PROPOSALS = 32;
const MAX_ITEMS = 2;
// Worst-case JSON.stringify expansion is six ASCII bytes per UTF-16 code unit
// (for example a C0 control), plus bounded schema and
// project metadata headroom.
export const MAX_PROPOSAL_BYTES = MAX_ITEMS * MAX_FACT * 6 + 32 * 1024;
const SCOPES = new Set(["project", "global", null]);
const PROPOSAL_STORE_LOCK = path.join(STATE, "memory-proposals.lock");
const PROPOSAL_ACCEPT_LOCKS = path.join(STATE, "memory-proposal-accept");

const ownKeysExactly = (value, allowed) => {
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return keys.length === expected.length && keys.every((key, i) => key === expected[i]);
};

function validateFact(fact) {
  if (typeof fact !== "string" || !fact.trim()) throw new Error("memory fact is empty");
  if (fact.length > MAX_FACT) throw new Error(`memory fact exceeds ${MAX_FACT} chars`);
  for (const char of fact) {
    const cp = char.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff)
      throw new Error("memory fact contains an unpaired surrogate");
  }
  return fact;
}

export function parseCandidateBlock(text) {
  if (typeof text !== "string") throw new Error("candidate text must be a string");
  if (text.includes("\r") && !text.includes("\r\n"))
    throw new Error("candidate text contains unsupported line endings");
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length < 1 || lines.length > MAX_ITEMS)
    throw new Error("candidate block must contain one or two lines");
  return lines.map((line) => {
    const match = line.match(/^Memory candidate(?: \((project|global)\))?: (.*)$/);
    if (!match) throw new Error("candidate block contains a non-canonical line");
    return { fact: validateFact(match[2]), scope: match[1] || null };
  });
}

export function parseProposalRequest(rawJson) {
  let value = rawJson;
  if (typeof rawJson === "string") {
    try { value = JSON.parse(rawJson); }
    catch { throw new Error("proposal request must be valid JSON"); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("proposal request must be a JSON object");
  if (value.schemaVersion !== PROPOSAL_SCHEMA_VERSION)
    throw new Error(`unsupported proposal schemaVersion: ${String(value.schemaVersion)}`);
  if (value.mode === "candidates") {
    if (!ownKeysExactly(value, ["schemaVersion", "mode", "text", "scopeOverride"]))
      throw new Error("candidate proposal has missing or unknown keys");
    if (!SCOPES.has(value.scopeOverride)) throw new Error("invalid scopeOverride");
    const items = parseCandidateBlock(value.text).map((item) => ({
      fact: item.fact,
      scope: value.scopeOverride ?? item.scope,
    }));
    return { mode: "candidates", items };
  }
  if (value.mode === "explicit") {
    if (!ownKeysExactly(value, ["schemaVersion", "mode", "text", "scope"]))
      throw new Error("explicit proposal has missing or unknown keys");
    if (!SCOPES.has(value.scope)) throw new Error("invalid scope");
    return { mode: "explicit", items: [{ fact: validateFact(value.text), scope: value.scope }] };
  }
  throw new Error(`unsupported proposal mode: ${String(value.mode)}`);
}

function proposalPath(id) {
  if (!PROPOSAL_ID_RE.test(String(id))) throw new Error("invalid proposal id");
  return path.join(MEMORY_PROPOSALS, id + ".json");
}

function ensureProposalDir() {
  fs.mkdirSync(MEMORY_PROPOSALS, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(MEMORY_PROPOSALS);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("proposal directory is not a safe directory");
  fs.chmodSync(MEMORY_PROPOSALS, 0o700);
}

function readRegularProposal(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error("proposal is not a regular file");
  if (st.size > MAX_PROPOSAL_BYTES) throw new Error("proposal file is too large");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new Error("proposal is not a regular file");
    if (opened.size > MAX_PROPOSAL_BYTES) throw new Error("proposal file is too large");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(fd));
    } catch {
      throw new Error("proposal file is not valid UTF-8");
    }
  } finally {
    fs.closeSync(fd);
  }
}

function validateStoredProposal(value, id, now) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("proposal file is malformed");
  if (!ownKeysExactly(value, [
    "schemaVersion", "id", "createdAt", "expiresAt", "origin", "mode", "project", "items",
  ])) throw new Error("proposal file has missing or unknown keys");
  if (value.schemaVersion !== PROPOSAL_SCHEMA_VERSION) throw new Error("proposal schema version mismatch");
  if (value.id !== id || value.origin !== "agent-recall-save") throw new Error("proposal identity mismatch");
  if (value.mode !== "candidates" && value.mode !== "explicit") throw new Error("proposal mode is invalid");
  const created = Date.parse(value.createdAt);
  const expires = Date.parse(value.expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires) ||
      new Date(created).toISOString() !== value.createdAt ||
      new Date(expires).toISOString() !== value.expiresAt ||
      created > now || expires - created !== PROPOSAL_TTL_MS)
    throw new Error("proposal timestamps are invalid");
  if (now >= expires) throw new Error("proposal has expired");
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > MAX_ITEMS)
    throw new Error("proposal items are invalid");
  for (const item of value.items) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        !ownKeysExactly(item, ["scope", "fact", "sha256"]) ||
        !SCOPES.has(item.scope) ||
        sha(validateFact(item.fact)) !== item.sha256)
      throw new Error("proposal item failed validation");
  }
  if (value.items.some((item) => item.scope !== "global")) {
    const p = value.project;
    if (!p || typeof p !== "object" || Array.isArray(p) ||
        !ownKeysExactly(p, [
          "kind", "top", "gitDir", "gitDev", "gitIno", "gitBirthtimeNs",
          "dev", "ino", "base", "dirKey",
        ]) ||
        !new Set(["git", "plain"]).has(p.kind) ||
        !path.isAbsolute(p.top) ||
        (p.kind === "git" ? !path.isAbsolute(p.gitDir) : p.gitDir !== null) ||
        (p.kind === "git"
          ? !/^\d+$/.test(p.gitDev || "") ||
            !/^\d+$/.test(p.gitIno || "") ||
            !/^\d+$/.test(p.gitBirthtimeNs || "")
          : p.gitDev !== null || p.gitIno !== null || p.gitBirthtimeNs !== null) ||
        typeof p.dev !== "string" || !/^\d+$/.test(p.dev) ||
        typeof p.ino !== "string" || !/^\d+$/.test(p.ino) ||
        typeof p.base !== "string" || !/^v2-[a-f0-9]{64}$/.test(p.dirKey))
      throw new Error("proposal project binding is invalid");
  } else if (value.project !== null) {
    throw new Error("global-only proposal must not have a project binding");
  }
  return value;
}

function cleanupAndCountLive(now) {
  ensureProposalDir();
  const names = fs.readdirSync(MEMORY_PROPOSALS);
  let live = 0;
  for (const name of names) {
    if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
    const file = path.join(MEMORY_PROPOSALS, name);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_PROPOSAL_BYTES) { live++; continue; }
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      const expires = Date.parse(value?.expiresAt || "");
      if (Number.isFinite(expires) && now >= expires) fs.unlinkSync(file);
      else live++;
    } catch {
      // Corrupt or concurrently changing entries still consume capacity.
      live++;
    }
  }
  return live;
}

function boundProject(items, cwd) {
  if (!items.some((item) => item.scope !== "global")) return null;
  const pk = projectKey(cwd);
  return {
    kind: pk.kind,
    top: pk.top,
    gitDir: pk.gitDir,
    gitDev: pk.gitDev,
    gitIno: pk.gitIno,
    gitBirthtimeNs: pk.gitBirthtimeNs,
    dev: pk.dev,
    ino: pk.ino,
    base: pk.base,
    dirKey: pk.dirKey,
  };
}

export function createMemoryProposal(request, { cwd = process.cwd(), now = Date.now() } = {}) {
  const parsed = request?.items ? request : parseProposalRequest(request);
  if (!parsed || (parsed.mode !== "candidates" && parsed.mode !== "explicit") ||
      !Array.isArray(parsed.items) || parsed.items.length < 1 || parsed.items.length > MAX_ITEMS)
    throw new Error("proposal request is invalid");
  const items = parsed.items.map((item) => {
    if (!SCOPES.has(item.scope)) throw new Error("invalid proposal item scope");
    const fact = validateFact(item.fact);
    return { scope: item.scope, fact, sha256: sha(fact) };
  });
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + PROPOSAL_TTL_MS).toISOString();
  const project = boundProject(items, cwd);
  return withProposalStoreLock(() => {
    if (cleanupAndCountLive(now) >= MAX_LIVE_PROPOSALS)
      throw new Error(`too many live memory proposals (limit ${MAX_LIVE_PROPOSALS})`);
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = crypto.randomBytes(16).toString("hex");
      const file = proposalPath(id);
      const stored = {
        schemaVersion: PROPOSAL_SCHEMA_VERSION,
        id,
        createdAt,
        expiresAt,
        origin: "agent-recall-save",
        mode: parsed.mode,
        project,
        items,
      };
      try {
        fs.writeFileSync(file, JSON.stringify(stored) + "\n", { flag: "wx", mode: 0o600 });
        fs.chmodSync(file, 0o600);
        loadMemoryProposal(id, { now });
        return {
          proposalId: id,
          expiresAt,
          itemCount: items.length,
          acceptCommand: `recall remember --accept ${id}`,
          memoryWritten: false,
        };
      } catch (error) {
        if (error?.code === "EEXIST") continue;
        try { fs.unlinkSync(file); } catch {}
        throw error;
      }
    }
    throw new Error("could not allocate a unique proposal id");
  });
}

export function loadMemoryProposal(proposalId, { now = Date.now() } = {}) {
  const id = String(proposalId);
  const file = proposalPath(id);
  let raw;
  try { raw = readRegularProposal(file); }
  catch (error) {
    if (error?.code === "ENOENT") throw new Error("proposal not found");
    throw error;
  }
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new Error("proposal file is malformed"); }
  return validateStoredProposal(value, id, now);
}

export function removeMemoryProposal(proposalId) {
  const file = proposalPath(String(proposalId));
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error("proposal is not a regular file");
  fs.unlinkSync(file);
}

export function withProposalAcceptanceLock(proposalId, fn) {
  const id = String(proposalId);
  proposalPath(id); // validate before using the id in a lock path
  return withOwnerLock(path.join(PROPOSAL_ACCEPT_LOCKS, id + ".lock"), fn);
}

export function withProposalStoreLock(fn) {
  return withOwnerLock(PROPOSAL_STORE_LOCK, fn);
}
