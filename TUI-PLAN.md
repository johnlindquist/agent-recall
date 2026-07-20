# TUI plan — adjudicated from the 4-seat design review (2026-07-20)

Seats: UX design, Go architecture, insight-lane boundary, scope skeptic.
Full answers in `.notes/oracle/tui-panel/` (untracked). This file records
the coordinator rulings on their conflicts and the build sequence.

## Rulings

1. **Sequence (UX "build it" vs skeptic "fzf-first"):** both. Phase 0 core
   primitives are prerequisites for *any* picker; Phase 1 ships a ~120-line
   fzf bridge immediately (instant win + the benchmark harness); Phase 2
   builds the Go+Charm TUI — wanted on its own merits — against the
   skeptic's guardrails (single-screen v1, ~900 production-line cap, 12
   canaries). The skeptic's comparative gate is reframed: not a kill
   switch, but the honesty check that decides which binary `rr` points at.
2. **Resume handoff:** `tea.ExecProcess` (arch + UX) with terminal
   restoration as a mandatory canary; if flaky on the real terminal,
   fall back to skeptic's quit-and-exec. Never a shell; typed argv from
   core; program allowlist; Kimi unavailable until core verifies a
   mechanism.
3. **Numbers:** debounce 90ms (arch), FTS candidates LIMIT 300 with the
   ≥95% top-20 overlap quality gate, preview ±8 lines, exact-token
   queries on Enter, prefix only on the final token at ≥3 chars.
4. **Result unit:** session rows keyed (source, session), opener as
   title, two-line rows, Enter always resumes; event-level evidence lives
   in the detail/preview layer (unanimous across seats).
5. **Redaction:** display-path sanitizer ported to Go behind a shared
   golden file (`contracts/text-display-goldens.json`) that BOTH Node and
   Go test suites consume; the stricter export-v1 policy (packs) stays
   Node-only. Raw transcript strings never cross into UI code (opaque
   sanitized types).
6. **Rebuild survival:** file-identity poll (os.SameFile, 1s) + DB
   generation counter + `meta.indexUuid` rotating on rebuild (insight
   seat's addition folded into the arch contract). Single read-only
   connection, no long transactions (verified WAL-bloat risk), results
   stamped with generation; stale generations fail closed.
7. **Driver:** ncruces/go-sqlite3 (wasm, FTS5) as conditional default;
   modernc as build-tag fallback; the WP2 benchmark gate on the real
   2.4GiB DB under concurrent sync + 20 rebuild cycles decides — from
   measured output, not preference. If neither passes, TUI falls back to
   batched `recall search --json` and drops the as-you-type claim.
8. **"What have we learned":** insight seat adopted wholesale as the
   later phases — `recall pack` (deterministic, export-v1 redaction,
   provenance-carrying, budget-trimmed) is the first cut and is honest
   even if handoff never ships; `recall synthesize` (typed agent
   profiles, stdin-only prompt, typed-SEND confirmation, egress audit
   log, feedback-loop canary) comes only after per-profile no-tools +
   no-feedback verification. No LLM in the TUI, ever; no `recall learn`
   naming — nothing is "learned" without human-approved memory.

## Build sequence

### Phase 0 — core primitives (Node; prerequisites for everything)
- `meta.schemaVersion = "1"` + `meta.indexUuid` (rotates on rebuild)
- `recall tui-bootstrap --json` (db path, versions, project keys,
  coverage, sources) and `recall status --json`
- Event-id addressing: `show-id`/`resume --json --source --session`
  returning typed `{available, verified, program, args, env, cwd, note}`
  (also closes the last-search.json race from ROADMAP #2)
- `contracts/` goldens: text-display, fts-expression, corpus-spec v1
- Falsifiable: unsafe id → available:false; no shell strings anywhere in
  JSON; bootstrap keys == core projectKey().

### Phase 1 — fzf bridge (ship same day)
- `rf` — small Node parent (≤~120 lines): static search → fzf with
  preview via `show-id`, Enter execs typed argv, Alt-keys cycle source.
- Doubles as the instrumented baseline (30 real runs, 40-task benchmark).

### Phase 2 — recall-tui v1 (Go + Charm, tui/ module in this repo)
- Skeptic's single-screen cut: query / grouped session list / preview /
  age footer; UX seat's keymap for what exists (Ctrl-G scope toggle,
  Tab filters later); honest states (degraded-zero wording mandatory).
- WP gates from the arch seat: walking skeleton → driver/WAL/rebuild
  benchmark gate → sanitizer port w/ goldens → async pipeline (seq +
  generation rejection races) → screens → typed resume → release
  hardening. 12 canaries before any release.
- Growth into the UX seat's full design (filter editor, detail screen,
  action palette, F2 coverage) is trigger-gated per the skeptic's table.

### Phase 3 — evidence & packs (trigger: ≥10 manual multi-session
  handoffs/month, per ROADMAP discipline)
- `recall pack` WP1+2 (CorpusSpec module, marked/auto selection,
  export-v1 redaction with hard-pattern rescan-abort, 0600 staging,
  deterministic hashes) — export-only first release.
- Evidence pane (bookends, session timeline, DEC? signal sort — exact
  honest labels, no fake synthesis), then `recall synthesize` behind
  per-profile canaries + typed-SEND confirmation + egress.jsonl audit.

## Kill/keep honesty check (30 days after Phase 2)
If the TUI doesn't beat the fzf bridge by ≥20%/300ms median
query-to-exec, ≥2 fewer actions on ambiguous tasks, or a materially
lower wrong-session rate — keep both binaries, point `rr` at fzf, and
stop growing the TUI. The archive/CLI remain the product either way;
the TUI is an optional leaf that owns no state and can be deleted
without loss.
