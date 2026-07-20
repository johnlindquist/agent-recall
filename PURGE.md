# Purging a session from agent-recall (manual procedure)

Sometimes a session captured something that should not be searchable — a
pasted secret, personal data, someone else's information. The archive is
deliberately append-only, so there is no `recall purge` command; removal is
a manual, eyes-on procedure. This document is that procedure, including an
honest account of what it **cannot** remove.

Throughout, `$R` is the store root:

```sh
R="${RECALL_HOME:-$HOME/Library/Application Support/AgentRecall}"
```

You need the session id (a UUID for Claude/Codex — it's in the resume
command `recall search` prints) or a distinctive phrase from the session
("the canary phrase") to find it.

## 1. Locate

The manifest at `$R/state/archive-manifest.json` maps every archived file:
`entries` is keyed by `"<source> <relative path>"` and each entry lists its
generation files (`gens`). The on-disk directory for an entry is
`$R/archive/<source>/<first-16-of-sha256-of-the-key>/`.

Find entries whose relative path contains the session id:

```sh
SID="<session-id>"
jq -r --arg sid "$SID" '
  .entries | to_entries[] | select(.key | contains($sid))
  | .key + "  gens: " + (.value.gens | join(","))
' "$R/state/archive-manifest.json"
```

Then find the actual generation files (the basename usually contains the
session UUID; `relpath.txt` in each dir records the original relative path):

```sh
grep -rl "$SID" "$R/archive" --include=relpath.txt
# or hunt by content with the canary phrase:
rg -l "the canary phrase" "$R/archive"
```

Note every matching directory before proceeding. One session can have
multiple generations (`g0001.jsonl`, `g0002.jsonl`, …) — they all count.

## 2. Remove

**Archive + manifest.** Delete each matched generation directory, then
remove its manifest entries so the archiver doesn't get confused about
sizes/tails:

```sh
rm -rf "$R/archive/<source>/<key>"     # for each matched dir

jq --arg sid "$SID" '
  .entries |= with_entries(select(.key | contains($sid) | not))
' "$R/state/archive-manifest.json" > "$R/state/archive-manifest.json.tmp" \
  && mv "$R/state/archive-manifest.json.tmp" "$R/state/archive-manifest.json"
```

**Index.** The recommended path: the index is a disposable projection, so
just delete it and rebuild from the (now-cleaned) archive:

```sh
rm -f "$R/state/recall.sqlite"
recall sync
```

If a full rebuild is too slow for you, surgical deletion also works —
delete the session's event rows and file checkpoints, then rebuild the FTS
shadow table (the delete triggers keep FTS consistent, but a rebuild
guarantees no orphaned trigrams):

```sh
sqlite3 "$R/state/recall.sqlite" "DELETE FROM events WHERE session='$SID';"
sqlite3 "$R/state/recall.sqlite" \
  "DELETE FROM files WHERE path NOT IN (SELECT DISTINCT path FROM events) AND path LIKE '%$SID%';"
sqlite3 "$R/state/recall.sqlite" "INSERT INTO events_fts(events_fts) VALUES('rebuild');"
```

Also clear the cached last search, which may hold snippets:

```sh
rm -f "$R/state/last-search.json"
```

## 3. Verify

Both of these must come back empty before you consider the purge done:

```sh
recall search "the canary phrase" --all     # index lane: expect no hits
rg -i "the canary phrase" "$R/archive"      # raw lane: expect no output
```

If either finds anything, go back to step 1 — you missed a generation or a
second source (the same session can be archived from more than one source
root, e.g. `codex-active` *and* `codex-archived`).

## 4. What this CANNOT purge

Be honest with yourself about the limits. This procedure removes the data
from the agent-recall store on this disk. It does not and cannot remove:

- **The original vendor transcript.** agent-recall archives *copies*. The
  source file still exists under `~/.claude/projects`,
  `~/.claude-second/projects`, `~/.codex/sessions` (and
  `archived_sessions`), `~/.grok/sessions`, `~/.kimi-code/sessions`,
  `~/.pi/agent/sessions`, etc. Delete it there separately — and note that
  the next `recall sync` would otherwise happily re-archive it.
- **Time Machine and other backups.** Any backup that ran while the data
  existed still contains it. The store is Time Machine-excluded by the
  installer, but the *vendor* transcript dirs are not, and neither are any
  third-party backups you run.
- **APFS local snapshots.** macOS keeps rolling local snapshots
  (`tmutil listlocalsnapshots /`); a deleted file can persist inside them
  until they age out or you delete them.
- **SSD wear-leveling remnants.** `rm` unlinks; flash translation layers
  may retain old blocks indefinitely. FileVault full-disk encryption is
  your real mitigation here.
- **Cloud copies held by the vendor.** The conversation happened through a
  hosted model. Whatever the provider retains server-side is governed by
  their retention policy, not by anything you do on this machine.

In short: this is best-effort local removal, not forensic erasure. Nothing
in this procedure should be described to anyone as "the data is gone
everywhere" — the honest claim is "it is no longer in my local archive or
index."
