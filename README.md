# agent-recall

**Local, cross-agent conversation search + shared memory for AI coding agents.**

Your coding agents forget everything between sessions — and some CLIs silently
delete your transcripts after 30 days. `agent-recall` archives every session
from every agent on your machine into one local, append-only store, indexes it
with SQLite FTS5, and gives both **you** and **your agents** one command to
search all of it:

```
$ recall search "oauth refresh loop"
recall: archive 2m · index 0m

[1] claude-second 2026-06-14 myapp user
    …the refresh loop was caused by the clock skew between…
    ↩ CLAUDE_CONFIG_DIR="$HOME/.claude-second" claude --resume a6de0e20-…

[2] codex-active 2026-06-02 myapp assistant tool:Bash
    …retry with exponential backoff fixed the refresh loop…
    ↩ codex resume 019f6873-…
```

Every hit carries the exact command to reopen that session in its original CLI.

## Supported sources

| Source | Location | Lane |
| --- | --- | --- |
| Claude Code | `~/.claude/projects` | append-preserving JSONL |
| Claude Code (2nd home) | `~/.claude-second/projects` | append-preserving JSONL |
| Codex CLI | `~/.codex/sessions` + `archived_sessions` | append-preserving JSONL |
| Grok CLI | `~/.grok/sessions` | append-preserving JSONL |
| Kimi CLI | `~/.kimi-code/sessions` + legacy `~/.kimi/sessions` | append-preserving JSONL |
| pi | `~/.pi/agent/sessions` | append-preserving JSONL |
| Google Antigravity | `~/.gemini/antigravity-cli/conversations` | **monitored, not yet archived** (per-conversation live SQLite needs a snapshot lane — planned) |

## Install

Requirements: macOS, Node ≥ 22.13 (built-in `node:sqlite` with FTS5), `jq`.
Optional: `ripgrep` for the `--raw` fallback lane.

```sh
git clone https://github.com/johnlindquist/agent-recall
cd agent-recall
./install.sh              # or ./install.sh --human-only  (no agent integration)
```

The installer is idempotent and reversible (`./install.sh --uninstall`). It:

1. **Stops transcript loss** — sets Claude Code `cleanupPeriodDays: 36500` in
   both config homes (originals backed up) and Codex `history.persistence =
   "save-all"`.
2. Creates the private store at `~/Library/Application Support/AgentRecall/`
   (mode `700`, excluded from Spotlight and Time Machine).
3. Installs the `recall` CLI to `~/.local/bin` and a launchd job that runs a
   bounded one-shot sync every 30 minutes — no daemon, no network, no
   telemetry, ever.
4. Adds a managed instruction block + skill so your agents automatically search
   history when you reference past work, and *propose* (never write) memory.
5. Runs an isolated self-test and a first full sync.

## Commands

```
recall search <words> [--all] [--raw] [--json] [--source NAME]
recall show <n>          # expand context around search hit n
recall sync              # archive + index now (launchd does this every 30m)
recall remember "<fact>" [--project]   # write one curated memory fact
recall context           # read curated facts (agents use this read-only)
recall doctor            # health, coverage, retention, launchd checks
recall self-test         # synthetic end-to-end verification (isolated)
```

## Design principles

Distilled from a research pass across the memory/search-tool ecosystem's issue
trackers (the failure modes below are all real, documented incidents in other
tools):

- **Archive before parse.** Transcripts are copied byte-for-byte into an
  append-only archive first; parsing/indexing happens only on the archived
  copies. Source deletion never propagates. Rewrites create new immutable
  generations instead of overwriting.
- **The index is disposable.** SQLite FTS5 is a projection; delete
  `state/recall.sqlite` any time and re-run `recall sync`. `recall search
  --raw` (ripgrep over the raw archive) works even with no index at all.
- **Tolerant parsing, honest coverage.** Unknown schemas are skipped and
  *counted*, never crashed on. Every search prints archive/index freshness and
  gaps — a degraded empty result never masquerades as "no history exists."
- **Curation over capture.** Nothing enters memory automatically. Agents
  propose `recall remember` commands; only the human runs them. (Auto-extracted
  memory is how another tool ended up 97.8% junk.)
- **Local only.** No network listeners, no cloud, no telemetry. Your
  transcripts contain secrets and personal data; they stay on disk, mode 600.
- **No daemons.** One bounded launchd one-shot with an mkdir lock. No orphan
  processes, no watchers, capped runtime/bytes/file counts.

## Known limitations

- Lexical search only (FTS5 + ripgrep) — no embeddings, by design, for now.
- ~Pretty-printed (multi-line) JSON files index as parse gaps; the `--raw`
  lane still covers them.
- Grok/Kimi resume commands are best-effort and labeled unverified.
- The archive is *preservation* against vendor deletion, not a backup — it
  lives on the same disk. Pair with FileVault + your own encrypted backups.
- Same-UID processes can read the store; there is no app-level encryption yet.
- macOS only (launchd). Linux/systemd would be a small port; PRs welcome.

## Uninstall

```sh
./install.sh --uninstall   # removes launchd job, CLI, agent integration;
                           # restores retention settings; PRESERVES your data
```

Then delete `~/Library/Application Support/AgentRecall/` yourself if you truly
want the archive gone.

## License

MIT
