// Resume-command hints per source. Session ids are validated against SAFE_ID
// BEFORE being interpolated into any printable command — hostile ids never
// reach a template string.

export const SAFE_ID = /^[A-Za-z0-9._-]{6,80}$/;

export function resumeHint(source, sessionId) {
  if (typeof sessionId !== "string" || !SAFE_ID.test(sessionId)) {
    return { cmd: null, note: "session id failed validation; resume manually" };
  }
  switch (source) {
    case "claude-primary":
      return { cmd: `claude --resume ${sessionId}` };
    case "claude-second":
      return { cmd: `CLAUDE_CONFIG_DIR="$HOME/.claude-second" claude --resume ${sessionId}` };
    case "codex-active":
    case "codex-archived":
      return { cmd: `codex resume ${sessionId}` };
    case "pi":
      return { cmd: `pi --session ${sessionId}` };
    case "grok":
      return { cmd: `grok --resume ${sessionId}  # unverified` };
    case "kimi-code":
    case "kimi-legacy":
      return { cmd: null, note: "open kimi and use its resume picker (unverified)" };
    default: // selftest / unknown sources
      return { cmd: null };
  }
}
