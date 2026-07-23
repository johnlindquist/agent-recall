# Roadmap — deferred items and their triggers

Everything here was deliberately deferred during the validated build
(2026-07-19). Each entry carries the observable trigger that justifies
building it — the discipline is: no trigger, no build.

## Build next (no trigger needed)

1. **Encrypted independent backup workflow** (`recall migrate pack`).
   The archive survives vendor deletion but not disk loss, and it is
   deliberately excluded from Time Machine for privacy. Design exists
   (checksummed, encrypted, restore-drill-verified pack to a user-chosen
   destination). This is the single point of failure in "never forget."
2. **Event-id addressing for `show`/resume** (replaces the shared
   `last-search.json` ordinal, which concurrent searches race) + typed
   `{program, args, env, cwd}` resume in `--json`. Lands naturally with
   the TUI work.
3. **`recall supersede <id>`** — the memory module supports
   supersede-with-replacement linking; only `forget` has a CLI surface.

## Trigger-gated

| Item | Build when |
| --- | --- |
| Antigravity parsing tier (index the snapshot DBs; schema-discovery + protobuf walker designed) | First real search miss for content known to be in an agy session |
| Gemini CLI chats connector (`~/.gemini/tmp/<hash>/chats`); Antigravity IDE workspaceStorage | Either becomes a daily-driver source |
| Embeddings (hybrid rerank over BM25, local model only) | Two misses in 30 days where a paraphrase would have matched but reasonable lexical variants didn't; must also pass: paraphrase Recall@5 +20pts, p95 ≤500ms, index ≤2× lexical, purge drill passes |
| Session-end retro / proposal automation | Manually saving ≥10 facts/month AND still losing ≥3 consequential facts/month |
| MCP server (stdio wrapper over the same CLI, never a listener) | Adopting an agent that cannot shell out but speaks MCP; plus 30 days of stable skill-based use |
| Compaction-capture hooks (PreCompact etc.) | Two unrecoverable compaction losses in 30 days that the 30-minute archive missed |
| Cross-machine sync | A second machine on the same projects ≥3 days/week (one-time moves: migrate pack) |
| Search scope ergonomics for unscoped events (some grok/kimi records hide behind `--include-unscoped`) | It bites in practice — then solve in TUI filters, not core |

`agent-recall-save` is deliberately narrower than the deferred session-end
automation: it is an explicit user-initiated acceptance mechanism, not automatic
extraction, autonomous memory writing, or a session-end trigger.

## Deferred indefinitely (documented, low regret)

- **Agent-safe output mode** (opaque ids, TTY-gated full search) — the
  security review's largest ask; it fights the tool's purpose for a
  personal install. Mandatory revisit if this ever serves multiple users.
- **Full-SHA archive directory keys** — 64-bit collision hardening whose
  migration risk outweighs its personal-threat-model value.
- **`projectOf` cwd-trust hardening** — hostile records claiming another
  project only affect display grouping; redaction caps the damage.
- **Windows/Linux port** (launchd → systemd/Task Scheduler is the only
  real work), chaos-drill runner, doctor `--install` gating.

## In design now

- **TUI** (Go + Charm; find→resume speed run; filters; context-pack
  handoff for "what have we learned" synthesis via an external agent) —
  4-seat design review in progress.
