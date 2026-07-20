// Record parsing for agent-recall: normalize Claude / Codex / Kimi / pi /
// generic transcript records into {role, kind, tool, text} events.
// parseRecord never throws and never yields thinking/system content.
import path from "node:path";

const SKIP_TYPE_RE = /thinking|reasoning|signature|encrypted|system/i;
const TEXT_KEYS = ["text", "content", "message", "prompt", "response", "output", "input", "body", "value", "arguments", "result"];
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

const jstr = (v) => { try { return JSON.stringify(v ?? ""); } catch { return ""; } };
const str = (v) => (typeof v === "string" ? v : "");

// Hidden-ness checks ROLE as well as TYPE at every object boundary: a
// {type:"message", role:"system"} record is just as hidden as {type:"system"}.
const hiddenNode = (v) =>
  !!v && typeof v === "object" &&
  (SKIP_TYPE_RE.test(str(v.type)) || SKIP_TYPE_RE.test(str(v.role)));

// Allowlist walk for the generic fallback; never descends into hidden items.
function textFrom(v, depth = 0, out = []) {
  if (depth > 4 || out.length > 20) return out;
  if (typeof v === "string") { if (v.trim()) out.push(v); return out; }
  if (Array.isArray(v)) { for (const x of v) textFrom(x, depth + 1, out); return out; }
  if (v && typeof v === "object") {
    if (hiddenNode(v)) return out;
    for (const k of TEXT_KEYS) if (k in v) textFrom(v[k], depth + 1, out);
  }
  return out;
}

// Content: string, or array of items. Any item with a string .text counts as a
// message (covers claude 'text' and codex 'input_text'/'output_text').
function* contentEvents(role, content) {
  if (SKIP_TYPE_RE.test(str(role))) return;
  if (typeof content === "string") { if (content.trim()) yield { role, kind: "message", tool: "", text: content }; return; }
  if (!Array.isArray(content)) return;
  for (const c of content) {
    if (typeof c === "string") { if (c.trim()) yield { role, kind: "message", tool: "", text: c }; continue; }
    if (!c || typeof c !== "object") continue;
    const t = str(c.type);
    if (hiddenNode(c)) continue;
    if (t === "tool_use" || t === "tool_call") { yield { role, kind: "tool", tool: c.name || "", text: jstr(c.input ?? c.arguments) }; continue; }
    if (t === "tool_result") { yield { role, kind: "tool_result", tool: c.name || "", text: textFrom(c.content).join("\n") || jstr(c.content) }; continue; }
    if (t === "function_call" || t === "function_call_output") { yield* responseItem(c); continue; }
    if (typeof c.text === "string" && c.text.trim()) yield { role, kind: "message", tool: "", text: c.text };
  }
}

// Codex response_item payload shapes (also bare records of the same shape).
function* responseItem(p) {
  const t = str(p.type);
  if (hiddenNode(p)) return;
  if (t === "message") { yield* contentEvents(str(p.role), p.content); return; }
  if (t === "function_call") { yield { role: "assistant", kind: "tool", tool: p.name || "", text: str(p.arguments) || jstr(p.arguments ?? p.input) }; return; }
  if (t === "function_call_output") yield { role: "tool", kind: "tool_result", tool: p.name || "", text: str(p.output) || textFrom(p.output).join("\n") || jstr(p.output) };
}

function* parseInner(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  const t = str(obj.type);

  // (b) Codex rollout envelope {timestamp, type, payload}.
  if (t && obj.payload && typeof obj.payload === "object") {
    const p = obj.payload;
    if (t === "response_item") { yield* responseItem(p); return; }
    if (t === "event_msg") {
      const pt = str(p.type);
      if (!hiddenNode(p) && (pt === "user_message" || pt === "agent_message") && str(p.message).trim())
        yield { role: pt === "user_message" ? "user" : "assistant", kind: "message", tool: "", text: p.message };
      return;
    }
    return; // session_meta, turn_context, ...: no events (may carry system prompts)
  }

  // (c) Kimi wire records use dotted types; only two carry non-system text.
  if (t.includes(".")) {
    if (t === "turn.prompt") { yield* contentEvents("user", obj.input); return; }
    if (t === "context.append_message" && obj.message && typeof obj.message === "object") {
      const m = obj.message, role = str(m.role);
      if (role === "system") return;
      yield* contentEvents(role, m.content);
      for (const tc of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
        if (!tc || typeof tc !== "object") continue;
        const args = tc.function?.arguments ?? tc.arguments ?? tc.input;
        yield { role: role || "assistant", kind: "tool", tool: tc.function?.name || tc.name || "", text: str(args) || jstr(args) };
      }
    }
    return; // metadata, config.update (systemPrompt!), tools.*, permission.*, context.append_loop_event
  }

  if (hiddenNode(obj) || t === "session" || t === "session_meta") return;

  // Bare codex-style tool records.
  if (t === "function_call" || t === "function_call_output") { yield* responseItem(obj); return; }
  if (t === "tool_call") { yield { role: "assistant", kind: "tool", tool: obj.name || obj.function || "", text: str(obj.arguments) || jstr(obj.arguments ?? obj.input) }; return; }

  // (a) Claude {type:'user'|'assistant', message:{role, content}} and bare {role, content}.
  const msg = obj.message && typeof obj.message === "object" ? obj.message : obj;
  if (hiddenNode(msg)) return;
  const role = str(msg.role) || str(obj.role) || t;
  let emitted = false;
  for (const ev of contentEvents(role, msg.content ?? msg.text ?? obj.content ?? obj.text)) { emitted = true; yield ev; }

  // (d) generic fallback allowlist walk.
  if (!emitted) {
    const texts = textFrom(obj);
    if (texts.length) yield { role: str(obj.role), kind: "other", tool: "", text: texts.join("\n") };
  }
}

export function* parseRecord(obj) {
  let out = [];
  try { out = [...parseInner(obj)]; } catch { /* tolerate anything */ }
  yield* out;
}

// Per-file context from header records: pi {type:'session'} and codex session_meta.
export function fileContext(obj, prev = {}) {
  if (!obj || typeof obj !== "object") return prev;
  let src = null;
  if (obj.type === "session") src = { session: obj.id, cwd: obj.cwd };
  else if (obj.type === "session_meta" && obj.payload && typeof obj.payload === "object")
    src = { session: obj.payload.session_id || obj.payload.id, cwd: obj.payload.cwd };
  if (!src) return prev;
  const next = { ...prev };
  if (typeof src.session === "string" && src.session) next.session = src.session;
  if (typeof src.cwd === "string" && src.cwd) next.cwd = src.cwd;
  return next;
}

export function sessionOf(obj, filePath, rel = "") {
  const o = obj && typeof obj === "object" ? obj : {};
  const fromObj = o.sessionId || o.session_id || (o.type === "session" && o.id) ||
    (o.type === "session_meta" && o.payload && (o.payload.session_id || o.payload.id));
  if (typeof fromObj === "string" && fromObj) return fromObj;
  const base = path.basename(String(filePath || ""));
  const m = base.match(UUID_RE);
  if (m) return m[1];
  // Generic filenames (e.g. Kimi's wire.jsonl): session identity lives in the
  // directory path — use the first segment of the source-relative path.
  const firstDir = String(rel || "").split(/[\\/]/)[0];
  if (firstDir && firstDir !== base) return firstDir;
  return base.replace(/\.[^.]+$/, "");
}

// Never throws: huge finite numbers (1e300) produce an invalid Date, guarded
// by Number.isNaN(d.getTime()). Seconds-vs-ms threshold is |v| < 1e11 so
// pre-Sept-2001 millisecond stamps are not misread as seconds. Strings are
// bounded to 128 chars and must Date.parse-validate; invalid input -> "".
export function tsOf(obj) {
  const o = obj && typeof obj === "object" ? obj : {};
  const v = o.timestamp ?? o.ts ?? o.created_at ?? o.createdAt ?? o.time ?? "";
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = new Date(Math.abs(v) < 1e11 ? v * 1000 : v);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  }
  if (typeof v === "string" && v) {
    const s = v.slice(0, 128);
    return Number.isNaN(Date.parse(s)) ? "" : s;
  }
  return "";
}

export function projectOf(obj, source, relDir, fileCwd) {
  if (typeof fileCwd === "string" && fileCwd) return fileCwd;
  if (obj && typeof obj.cwd === "string" && obj.cwd) return obj.cwd;
  if (String(source).startsWith("claude") || source === "pi") return String(relDir || "").split(/[\\/]/)[0] || "";
  return "";
}

// Pretty-printed whole-file JSON (grok and friends): array => records, object => [object].
export function parseWholeJson(buf) {
  const v = JSON.parse(String(buf));
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") return [v];
  throw new Error("whole-file JSON is not an object or array");
}

export const DECISION_RE = /\b(we decided|let's go with|use .* instead|don't|do not|never|always|actually|that's wrong|instead of)\b/i;

export const eventWeight = ({ role, kind, opener, text = "" }) => {
  let w;
  if (kind === "message") w = role === "user" ? (opener ? 2.5 : 2.0) : 1.0;
  else if (kind === "tool") w = 0.7;
  else if (kind === "tool_result") w = 0.5;
  else w = 0.6;
  if (DECISION_RE.test(text)) w = Math.min(w + 0.5, 3.0);
  return w;
};
