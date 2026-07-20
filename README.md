# agent-recall

**Local, cross-agent conversation search + shared memory for AI coding agents.**

Your coding agents forget everything between sessions — and some CLIs delete
transcripts after 30 days. `agent-recall` periodically copies the session
files it can read from every supported agent on your machine into a local,
append-preserving archive, indexes them with SQLite FTS5, and gives both
**you** and **your agents** one command to search all of it:

```
$ recall search "oauth refresh loop"
recall: archive 4m · index 0m · sources ok:8 · gaps:102,142

[1] claude-second 2026-06-14 · myapp · user
    ❝Fix the OAuth refresh loop in the session middleware❞
    …the refresh loop was caused by the clock skew between…
    ↩ CLAUDE_CONFIG_DIR="$HOME/.claude-second" claude --resume a6de0e20-…

[2] codex-active 2026-06-02 · myapp · assistant · tool:Bash
    …retry with exponential backoff fixed the refresh loop…
    ↩ codex resume 019f6873-…
```

Each hit shows the session's opening request as its title, a redacted
snippet, and — when the session id validates and the CLI's resume syntax is
known — the exact command to reopen that session.

## Supported sources

| Source | Location | Lane |
| --- | --- | --- |
| Claude Code (two config homes) | `~/.claude/projects`, `~/.claude-second/projects` | append-preserving JSONL |
| Codex CLI | `~/.codex/sessions` + `archived_sessions` | append-preserving JSONL (envelope-aware parser) |
| Grok CLI | `~/.grok/sessions` | append-preserving; JSONL indexed, pretty-JSON via `--raw` |
| Kimi CLI | `~/.kimi-code/sessions` (+ legacy `~/.kimi/sessions`) | append-preserving JSONL (`wire.jsonl`, session-from-path) |
| pi | `~/.pi/agent/sessions` | append-preserving JSONL |
| Google Antigravity | `~/.gemini/antigravity-cli/conversations` | **gated SQLite snapshot lane** — enable with `recall agy-enable` (WAL-safe online backup; archived, searchable via `--raw`; not yet parsed into the index) |

## Install

Requirements: macOS, Node ≥ 22.13 with `node:sqlite` FTS5 (the installer
probes this before touching anything), `jq`. Optional: `ripgrep` for the
`--raw` lane.

```sh
git clone https://github.com/johnlindquist/agent-recall
cd agent-recall
./install.sh              # or ./install.sh --human-only  (no agent integration)
```

The installer is transactional (preflight → isolated self-test → staged and
validated artifacts → apply) and reversible (`./install.sh --uninstall`,
which works even without Node). It:

1. **Raises Claude Code transcript retention** (`cleanupPeriodDays: 36500`)
   in both config homes, with one-time backups restored on uninstall if the
   value is still ours. (Codex already retains transcripts by default and is
   deliberately not modified.) The scheduled archive — not any vendor
   setting — is the real safeguard.
2. Creates the private store at `~/Library/Application Support/AgentRecall/`
   (mode `700`, `umask 077` throughout; Spotlight exclusion marker; Time
   Machine exclusion *attempted*, warned about if it fails).
3. Installs the `recall` CLI to `~/.local/bin` and a launchd job that runs a
   watchdog-bounded one-shot sync every 30 minutes while you're logged in
   (missed intervals are not queued). No daemon, no network listener, no
   telemetry. Wrappers pass Node a sanitized environment (no `NODE_OPTIONS`,
   `RIPGREP_CONFIG_PATH`, or `DYLD_*` passthrough).
4. Adds a managed instruction block + skill so your agents are *asked* to
   search history when you reference past work and to propose (never write)
   memory — this is behavioral guidance for the agents, not an enforcement
   boundary; the one hard gate is that `recall remember` refuses
   non-interactive callers.
5. Runs an isolated self-test and a first full sync (bounded; large corpora
   index over multiple passes).

## Commands

```
recall search <words> [--all] [--raw] [--json] [--source NAME] [--include-unscoped]
recall show <n> | summary <n>    context / opening-ask+last-answer for hit n
recall sync                      archive + index now (launchd does this every 30m)
recall remember "<fact>" [--project]   # human-only: requires an interactive terminal
recall context                   curated facts (read-only for agents; stale facts flagged)
recall forget "<text or id>"     retract a fact (file preserved, excluded from context)
recall doctor                    health + per-source coverage + integrity checks
recall agy-enable                enable the Antigravity snapshot lane (runs a WAL canary gate first)
recall index [--rebuild] | archive | self-test
```

## Design principles

Distilled from a research pass across the memory/search-tool ecosystem's
issue trackers, then validated by adversarial review (the failure modes
below are documented incidents in other tools):

- **Archive before parse.** Transcripts are copied byte-for-byte (with
  crash-consistent, fsync'd, no-clobber commit protocols) into an
  append-preserving archive; parsing happens only on archived copies.
  Source deletion never propagates. Rewrites create new immutable
  generations, verified by full prefix comparison — never a sampled hash.
- **The index is disposable.** SQLite FTS5 is a projection; parser upgrades
  rebuild it automatically from the archive. `recall search --raw` (ripgrep,
  `--no-config`, sanitized env) works with no index at all.
- **Coverage is honest and persistent.** Every search prints per-source
  freshness and a permanent gap ledger (`index_gaps`) that survives no-op
  runs. A source with archived files but zero indexed events is loudly
  UNCOVERED. A degraded empty result never claims "no history exists."
- **Curation over capture.** Nothing enters memory automatically. Agents
  propose plain-text candidates; only a human at an interactive terminal can
  run `recall remember`. Facts age (staleness flags), retract without
  deletion, and are read as pointers to verify — not authority.
- **Recalled content is inert.** Output is sanitized against terminal-escape
  and spoofing tricks, likely credentials/PII are redacted on display (best
  effort — scanning is never complete), session ids are allowlist-validated
  before any resume command is printed, and agents are instructed to treat
  everything recalled as data, never instructions.
- **Local only. No daemons.** No network APIs anywhere in the codebase; a
  bounded launchd one-shot with owner-token locks (concurrent runs exit 75,
  they don't corrupt or lie). Note: agent-recall itself opens no sockets,
  but any *agent* that reads recall output may transmit it to its own model
  provider — that's the nature of using cloud agents.

## Known limitations (deliberate)

- Lexical search only (FTS5 + ripgrep); no embeddings.
- Not everything indexes: pretty-printed JSON, unknown schemas, and
  oversized lines become counted, permanent gaps covered by `--raw`.
- The archive is **preservation against vendor deletion, not a backup** —
  it lives on the same disk, and capture is periodic (a session created and
  deleted between syncs can be missed; a budget-capped run reports itself
  as incomplete). Pair with FileVault and your own encrypted backups.
- Same-UID processes can read the store; there is no app-level encryption.
  Grok/Kimi resume syntax is unverified and labeled as such. Search hit
  state (`show <n>`) is a single shared file — concurrent searches from
  multiple terminals can race it.
- macOS only (launchd). See `PURGE.md` for honest removal semantics
  (including what deletion *cannot* purge: snapshots, backups, SSD
  remnants, vendor copies).

## Uninstall

```sh
./install.sh --uninstall   # transactional; restores retention if still ours;
                           # PRESERVES all archived data
```

Then delete `~/Library/Application Support/AgentRecall/` yourself if you
want the archive gone.

## License

MIT
