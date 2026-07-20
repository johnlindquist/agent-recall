// Text hygiene for display: control-char stripping + best-effort redaction.
// redact() is DISPLAY ONLY masking — never treat its output as sanitized-for-storage.

// C0 controls (minus \n \t), DEL, C1 controls, bidi/embedding marks
// (LRM, RLM, LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI). Escapes only — no raw bytes.
const CONTROL_RE = new RegExp(
  "[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F" +
    "\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]",
  "g",
);

export const clean = (s) => String(s ?? "").replace(CONTROL_RE, " ");

// One-line terminal fields (source, project, role, tool, path, snippet, ...):
// clean, then collapse tabs/newlines/CR/line+paragraph separators to a space
// so content can never fake extra output lines or impersonate headers.
export const terminalLine = (s) => clean(String(s)).replace(/[\t\n\r\u2028\u2029]+/g, " ");

// Ordered: private-key blocks must run before any generic key/token pattern
// so block bodies never leak through a partial match.
const RULES = [
  // -----BEGIN (RSA|EC|DSA|OPENSSH|ENCRYPTED|PGP ... ) PRIVATE KEY( BLOCK)-----
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]+?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
    "[redacted:private-key]"],
  // JWT: three base64url segments, header starts eyJ ('{"' base64d)
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "[redacted:jwt]"],
  // GitHub tokens
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted:github-token]"],
  // Slack tokens
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted:slack-token]"],
  // AWS access key id
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted:aws-key]"],
  // sk-/rk-/pk- style API keys (OpenAI, Stripe-ish, etc.)
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, "[redacted:api-key]"],
  // Bearer <token>
  [/\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g, "Bearer [redacted:bearer]"],
  // key = value / key: value assignments. Quoted values >=4 chars; unquoted
  // values must be >=8 chars of token-ish charset (no dots) so code like
  // `token = process.env.TOKEN` or `= await getToken()` is not mangled.
  [/\b(password|passwd|pwd|api[_-]?key|apikey|access[_-]?(?:key|token)|auth[_-]?token|client[_-]?secret|secret|token)\b\s*[:=]\s*(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[A-Za-z0-9_+/-]{8,}={0,2})/gi,
    (_, key) => `${key}=[redacted:credential]`],
  // Emails
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[redacted:email]"],
  // US phones with separators: (303) 906-0715 / 303-906-0715 / +1 303.906.0715.
  // Separators are required so 10-digit ids/timestamps are left alone.
  [/(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s*|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g, "[redacted:phone]"],
];

export function redact(s) {
  let out = String(s ?? "");
  for (const [re, sub] of RULES) out = out.replace(re, sub);
  return out;
}

export const display = (s) => redact(clean(s));
