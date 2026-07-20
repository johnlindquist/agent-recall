// Shared constants for agent-recall. Every lib module imports from here.
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const HOME = os.homedir();
export const ROOT = process.env.RECALL_HOME || path.join(HOME, "Library/Application Support/AgentRecall");
export const ARCHIVE = path.join(ROOT, "archive");
export const STATE = path.join(ROOT, "state");
export const MEMORY = path.join(ROOT, "memory");
export const BIN = path.join(ROOT, "bin");
export const LOGS = path.join(ROOT, "logs");
export const DB_PATH = path.join(STATE, "recall.sqlite");
export const MANIFEST = path.join(STATE, "archive-manifest.json");
export const LAST_SEARCH = path.join(STATE, "last-search.json");

export const MAX_TEXT = 32 * 1024;         // max indexed text per event
export const PARSER_VERSION = "2";          // bump => automatic full index rebuild

export const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// Source registry: name -> live root. Keep in sync with bin/archive.mjs.
export const SOURCES = {
  "claude-primary": path.join(HOME, ".claude/projects"),
  "claude-second": path.join(HOME, ".claude-second/projects"),
  "codex-active": path.join(HOME, ".codex/sessions"),
  "codex-archived": path.join(HOME, ".codex/archived_sessions"),
  grok: path.join(HOME, ".grok/sessions"),
  "kimi-code": path.join(HOME, ".kimi-code/sessions"),
  "kimi-legacy": path.join(HOME, ".kimi/sessions"),
  pi: path.join(HOME, ".pi/agent/sessions"),
};
