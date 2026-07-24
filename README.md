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
| Grok CLI | `~/.grok/sessions` | append-preserving; structured JSONL indexed, diagnostic/terminal `.log` artifacts raw-only |
| Kimi CLI | `~/.kimi-code/sessions` (+ legacy `~/.kimi/sessions`) | append-preserving; `wire.jsonl` indexed (session-from-path), `kimi-code.log`/`output.log` raw-only |
| pi | `~/.pi/agent/sessions` | append-preserving JSONL |

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
which works even without Node). It raises Claude Code transcript retention
(with one-time backups), creates the private store at
`~/Library/Application Support/AgentRecall/` (mode `700`, `umask 077`,
Spotlight-excluded, Time Machine exclusion attempted and warned about),
installs the `recall` CLI plus a watchdog-bounded launchd one-shot every 30
minutes, and adds a managed instruction block + skill so your agents are
*asked* to search history and to propose (never write) memory.

## Commands

```
recall search <words> [--all] [--raw] [--json] [--source NAME] [--include-unscoped]
recall show <n> | summary <n>    context / opening-ask+last-answer for hit n
recall sync                      archive + index now (launchd does this every 30m)
recall propose-memory --json      stage a 30-minute proposal; writes no curated memory
recall remember --accept <id>     review a proposal; interactive terminal + exact SAVE required
recall remember "<fact>" [--project|--global] [--]  # direct human-only path
recall context                   curated facts (read-only for agents; stale facts flagged)
recall forget "<text or id>"     direct human-only retraction (file preserved)
recall doctor                    health + per-source coverage + integrity checks
recall index [--rebuild] | archive | self-test
```

## Saving proposed memories

The installed `agent-recall-save` skill is an explicit, two-phase acceptance
flow. An agent may stage a proposal only after the current user asks it to save
explicit text or accept the most recent candidate block. Staging returns
`memoryWritten: false`; proposals never appear in `recall context` and expire
after 30 minutes. The agent returns:

```sh
recall remember --accept <proposal-id>
```

Run that command yourself in an interactive terminal. It previews the exact
JSON-escaped facts, scopes, hashes, and duplicate status, then requires the
case-sensitive token `SAVE`. Project scope is bound when the proposal is staged,
even if acceptance runs from another directory. Exact active duplicates in the
same scope are idempotent; identical text in global and project scope remains
two distinct facts. Evidence suffixes are ordinary exact fact text.

With no explicit payload, the skill reads only the immediately preceding
assistant turn's final contiguous block of one or two canonical lines:

```text
Memory candidate (project): Use Base UI, not Radix — evidence: package.json.
Memory candidate (global): Prefer exact UTC dates in release notes.
```

It does not search older turns or recalled history. Examples:

```text
User: Accept the project memory candidate.
Agent: Proposal staged; nothing has been saved yet. Run: recall remember --accept <id>

User: agent-recall-save Remember "quotes", Unicode — punctuation,
      and this second line exactly.
Agent: Proposal staged with unresolved scope; nothing has been saved yet.

Duplicate: the terminal reports "already active" and creates no second file.
Expired: acceptance fails closed; stage a fresh proposal.
No candidate: the skill reports that no valid recent candidate block exists.
```

This does not add automatic extraction, session-end automation, fuzzy
deduplication, bulk memory management, agent-side acceptance, background memory
services, cross-machine sync, or automatic superseding. Humans can still use
direct `recall remember "<fact>" [--project|--global]`.
Direct `recall forget` is likewise interactive and human-only. Project facts
are bound to collision-proof hashed project keys; older plain-basename project
directories remain preserved on disk as unbound legacy data rather than being
silently attributed to unrelated projects with the same basename.

## Why it's built this way

This tool was designed backwards from failure evidence: a mining pass over
the issue trackers of 25+ agent-memory and session-search tools and the
native CLI trackers (mid-2026), followed by an adversarial multi-model
review whose findings were fixed before publication. Every load-bearing
decision below links to the incidents that motivated it.

### Fix retention first, then archive independently

Claude Code deletes transcripts after 30 days by default, keyed on file
*mtime* — so backup restores and sync tools can make live sessions look old,
and users have reported losing years of work with no warning or recovery
([anthropics/claude-code#59248](https://github.com/anthropics/claude-code/issues/59248));
setting the knob to `0` has been reported to mean "delete everything," not
"off" ([#23710](https://github.com/anthropics/claude-code/issues/23710)).
Codex fails in the opposite direction — no retention control at all
([openai/codex#6015](https://github.com/openai/codex/issues/6015)). So the
installer raises Claude's retention as defense-in-depth, but the scheduled
append-preserving archive — outside every vendor's deletion policy — is the
actual guarantee. Vendors have also declined to bridge history even between
their *own* surfaces
([codex#4268](https://github.com/openai/codex/issues/4268),
[claude-code#2511](https://github.com/anthropics/claude-code/issues/2511)),
which is why a neutral local archive exists at all.

### Watch files; never hook the agent runtime

Every tool that integrates via lifecycle hooks accumulates "capture
silently stopped after the host updated" issues — claude-mem's OpenCode
plugin loading but capturing nothing
([thedotmack/claude-mem#2832](https://github.com/thedotmack/claude-mem/issues/2832))
is one of a genre. The maintainer of basic-memory reached the same
conclusion designing a transcript-watching sidecar: runtime injection is
"fragile, vendor-specific, opaque"
([basicmachines-co/basic-memory#669](https://github.com/basicmachines-co/basic-memory/issues/669)).
agent-recall reads transcript files and touches nothing else.

### Archive before parse; tolerate schema drift

Session formats are explicitly unstable: one Claude-Code-only viewer
maintains a rolling series of per-release compatibility issues
([delexw/claude-code-trace](https://github.com/delexw/claude-code-trace/issues?q=compat)),
another accumulated 10+ recurring schema-validation crashes
([d-kimuson/claude-code-viewer#161](https://github.com/d-kimuson/claude-code-viewer/issues/161)),
and cass broke repeatedly on OpenCode storage migrations
([Dicklesworthstone/coding_agent_session_search#227](https://github.com/Dicklesworthstone/coding_agent_session_search/issues/227)).
So parsing here is skip-and-continue over *archived copies* — a parser
failure can never lose data, only leave a counted gap — and a parser-version
bump automatically rebuilds the whole index from the archive.

### The index is disposable; resources are bounded; no daemons

The scale failures in this space are spectacular: 410 GB of orphaned staging
files overnight
([cass#324](https://github.com/Dicklesworthstone/coding_agent_session_search/issues/324)),
24–36 GB RSS on large corpora
([cass#326](https://github.com/Dicklesworthstone/coding_agent_session_search/issues/326)),
a sync that hangs at ~500 sessions across five releases
([specstoryai/getspecstory#180](https://github.com/specstoryai/getspecstory/issues/180)),
120 GB of checkpoints with no GC
([cline/cline#3790](https://github.com/cline/cline/issues/3790)), and
background workers leaking hundreds of orphan processes
([claude-mem#3301](https://github.com/thedotmack/claude-mem/issues/3301)).
Hence: streaming line scanner with hard per-line caps, time-budgeted runs
that checkpoint mid-file, owner-token locks where a busy competitor exits 75
instead of corrupting or lying, one launchd one-shot with a watchdog instead
of any resident daemon — and an index you can delete at any time, because
the archive is canonical.

### Coverage is honest, per-source, and permanent

The most common bug shape across every memory tool we studied is *silent
failure*: writes that report success and store nothing
([supermemoryai/supermemory#792](https://github.com/supermemoryai/supermemory/issues/792)),
resets that delete nothing
([mem0ai/mem0#6411](https://github.com/mem0ai/mem0/issues/6411)), and search
that quietly indexed only tool *names*, not contents
([jhlee0409/claude-code-history-viewer#429](https://github.com/jhlee0409/claude-code-history-viewer/issues/429)).
This project hit its own version during development — an early generic
parser produced **zero** indexed events for 4,630 archived Codex files while
an aggregate "unparsed lines" counter hid it. The response is structural:
per-source coverage in every search and doctor run ("discovered is not
covered"), a persistent `index_gaps` ledger that survives no-op runs, and a
hard output rule — a degraded empty result must say so, never "no history."

### Memory is curated, human-gated, and append-only

The landmark audit here is mem0's production deployment where **97.8% of
10,134 auto-extracted memories were junk** — boot-context re-extracted every
session, plus a 668-copy feedback loop from re-extracting recalled content
([mem0ai/mem0#4573](https://github.com/mem0ai/mem0/issues/4573)). LLM-managed
memory files have also been observed destroying their own history by
overwriting instead of appending
([GreatScottyMac/roo-code-memory-bank#21](https://github.com/GreatScottyMac/roo-code-memory-bank/issues/21)),
and every mainline agent asked to build Memory Bank in declined, calling any
memory schema too opinionated for a general tool
([RooCodeInc/Roo-Code#3312](https://github.com/RooCodeInc/Roo-Code/issues/3312)).
So here: nothing persists automatically; agents propose plain-text candidates
or stage short-lived proposals only after an explicit user request;
`recall remember` refuses non-interactive callers (a prompt-injected agent
cannot write memory); facts retract without deletion,
age with staleness flags, and are read as pointers to verify against
reality — because shipped auto-memory's top complaint quickly becomes "the
model ignores it or trusts it stale"
([google-gemini/gemini-cli#13852](https://github.com/google-gemini/gemini-cli/issues/13852)).

### Recalled content is treated as hostile input

Transcripts contain secrets and attacker-influenced text (web pages, tool
output, cloned repos). Real incidents in adjacent tools include session
capture leaking secrets into public git branches
([entireio/cli#340](https://github.com/entireio/cli/issues/340)), redaction
that misses low-entropy keys
([entireio/cli#1716](https://github.com/entireio/cli/issues/1716)), history
files not gitignored (filed as a security issue,
[getspecstory#224](https://github.com/specstoryai/getspecstory/issues/224)),
and a popular memory plugin exposing all captured sessions on an
unauthenticated local port
([claude-mem#1251](https://github.com/thedotmack/claude-mem/issues/1251)).
Our own adversarial review added reproduced findings: session filenames as
shell-injection vectors in printed resume commands, and ripgrep executing an
arbitrary preprocessor via an inherited `RIPGREP_CONFIG_PATH`. Hence:
best-effort credential/PII redaction on all display paths, terminal-escape
and spoofing sanitization, allowlist-validated session ids before any
command is printed, `rg --no-config` with a sanitized environment, no
network APIs anywhere, and instruction text that frames every recalled byte
as inert data. (Honest boundary: agent-recall opens no sockets, but any
cloud agent that reads its output transmits it; and same-UID malware is out
of scope — FileVault plus `0700` is the line.)

### Lexical search first; embeddings behind an evidence gate

Practitioners in this niche keep converging on the same verdict: for coding
recall — exact errors, identifiers, paths — BM25-style lexical search wins,
and vector pipelines get abandoned (see the "versioned folders of markdown"
sentiment and the no-database design of
[sinzin91/search-sessions](https://github.com/sinzin91/search-sessions);
fast-resume's author chose typo-tolerant lexical over embeddings
deliberately). The one tool in this space that shipped semantic search
concentrates its worst stability failures there
([cass#347](https://github.com/Dicklesworthstone/coding_agent_session_search/issues/347)).
An embedding index is also one more PII derivative every purge must
enumerate. So: FTS5 with structural ranking (user messages and session
openers weighted above tool noise, per the field evidence that recency- and
role-blind injection performs worst,
[claude-mem#1573](https://github.com/thedotmack/claude-mem/issues/1573)),
and semantic search only when real usage shows paraphrase queries failing
lexical ones — a measured gate, not a fashion choice. The disposable index
makes reversing this decision a version bump, not a migration.

## Regression verification

The known false-corruption classes have hermetic guards that use temporary
archives and temporary source copies only:

```sh
NODE_NO_WARNINGS=1 node scripts/verify-corruption-regressions.mjs
NODE_NO_WARNINGS=1 node scripts/verify-corruption-negative-controls.mjs
```

The first command exercises real Grok, Kimi, and Codex parsing/indexing and
prints `GUARD_PASS` only when raw logs stay out of the structured index,
Codex compaction envelopes do not become gaps, and unrelated oversized
records still do. The second command deliberately reintroduces each bug in a
temporary copy and prints two `NEGATIVE_CONTROL_PASS` lines only when the
first guard rejects both mutations for the expected reason.

## Known limitations (deliberate)

- Lexical only; no embeddings (see gate above).
- Pretty-printed JSON, unknown schemas, and unknown oversized records become
  counted permanent gaps covered by `--raw` — not silently dropped, not
  indexed. Recognized top-level Codex `compacted` envelopes are consumed
  without a gap because they intentionally emit no searchable events; their
  original bytes remain in the canonical archive and raw lane.
- The archive is **preservation against vendor deletion, not a backup** —
  same disk, periodic capture (a session created and deleted between syncs
  can be missed). Pair with FileVault and your own encrypted backups.
- Same-UID processes can read the store; no app-level encryption. Grok/Kimi
  resume syntax is unverified and labeled as such. `show <n>` state is a
  single shared file — concurrent searches from multiple terminals can race.
- macOS only (launchd). See `PURGE.md` for honest removal semantics,
  including what deletion *cannot* purge (snapshots, backups, SSD remnants,
  vendor copies).

## Uninstall

```sh
./install.sh --uninstall   # transactional; restores retention if still ours;
                           # PRESERVES all archived data
```

Then delete `~/Library/Application Support/AgentRecall/` yourself if you
want the archive gone.

## License

MIT
