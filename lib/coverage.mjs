// lib/coverage.mjs — the research mandate: discovered != covered. Compares
// what the archiver has captured (manifest) against what the index can search.
// Status degrades on ANY signal that a miss might not mean "no history":
// uncovered source, stale archive, no index run, index behind archive,
// persistent index gaps, budget-truncated index run, failed file txns.
import fs from "node:fs";
import { MANIFEST, SOURCES } from "./paths.mjs";
import { eventCounts, gapCount, gapSummary } from "./db.mjs";

export function manifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); } catch { return null; }
}

const ageMin = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? Math.round((Date.now() - t) / 60000) : null;
};

const fmt = (n) => Number(n).toLocaleString("en-US");

export function coverage(db) {
  const m = manifest();
  const archAgeMin = ageMin(m?.lastRun?.at);
  const idxIso = db.prepare("SELECT v FROM meta WHERE k='lastIndex'").get()?.v;
  const idxAgeMin = ageMin(idxIso);
  const counts = eventCounts(db);

  // manifest entries are keyed "<source> <rel>" — count archived files per source
  const archived = {};
  for (const id of Object.keys(m?.entries || {})) {
    const src = id.slice(0, id.indexOf(" ") === -1 ? id.length : id.indexOf(" "));
    archived[src] = (archived[src] || 0) + 1;
  }

  const gaps = [];
  let degraded = false;
  const perSource = {};
  for (const src of new Set([...Object.keys(SOURCES), ...Object.keys(archived), ...Object.keys(counts)])) {
    const archivedFiles = archived[src] || 0;
    const { events = 0, sessions = 0 } = counts[src] || {};
    let state = "ok";
    if (archivedFiles > 50 && events === 0) {
      state = "uncovered";
      degraded = true;
      gaps.push(`SOURCE ${src}: ${archivedFiles} files archived, 0 indexed (UNCOVERED — use --raw)`);
    } else if (archivedFiles === 0) {
      // known source with no live dir on disk -> missing; otherwise just empty
      state = SOURCES[src] && !fs.existsSync(SOURCES[src]) ? "missing" : "empty";
    }
    perSource[src] = { archivedFiles, events, sessions, state };
  }

  if (archAgeMin === null) gaps.push("no archive run yet");
  else if (archAgeMin > 24 * 60) { degraded = true; gaps.push(`archive STALE (${Math.round(archAgeMin / 60)}h old)`); }

  if (idxAgeMin === null) { degraded = true; gaps.push("no index run yet"); }
  else if (m?.lastRun?.at && Date.parse(idxIso) + 1000 < Date.parse(m.lastRun.at)) {
    degraded = true;
    gaps.push("index older than archive (run recall sync)");
  }

  let stats = {};
  try { stats = JSON.parse(db.prepare("SELECT v FROM meta WHERE k='lastIndexStats'").get()?.v || "{}"); } catch {}
  if (stats.parseErrors > 0) gaps.push(`${stats.parseErrors} unparsed lines (rg fallback: recall search --raw)`);
  if (stats.budgetHit) { degraded = true; gaps.push("last index run hit its time budget (index incomplete)"); }
  if (stats.fileErrors > 0) { degraded = true; gaps.push(`${stats.fileErrors} file transactions failed last index run`); }

  const gapTotal = gapCount(db);
  const gapsByKind = gapTotal > 0 ? gapSummary(db) : {};
  if (gapTotal > 0) {
    degraded = true;
    const parts = Object.entries(gapsByKind).map(([k, c]) => `${k} ${fmt(c)}`).join(" / ");
    gaps.push(`${fmt(gapTotal)} permanent index gaps (${parts})`);
  }

  if (m?.lastRun?.counts?.storageSkipped) gaps.push(`${m.lastRun.counts.storageSkipped} files skipped (budget)`);

  return {
    archAgeMin, idxAgeMin,
    status: degraded ? "degraded" : "ok",
    gaps, perSource, gapTotal, gapsByKind,
  };
}

export function banner(cov) {
  const tally = { ok: 0, empty: 0, missing: 0 };
  const unc = [];
  for (const [src, s] of Object.entries(cov.perSource)) {
    if (s.state === "uncovered") unc.push(`${src} ${s.events}/${s.archivedFiles}`);
    else tally[s.state]++;
  }
  let line = `recall: archive ${cov.archAgeMin ?? "?"}m · index ${cov.idxAgeMin ?? "?"}m` +
    ` · sources ok:${tally.ok} empty:${tally.empty}` +
    (tally.missing ? ` missing:${tally.missing}` : "") +
    (cov.gapTotal ? ` · gaps:${fmt(cov.gapTotal)}` : "") +
    (unc.length ? ` UNCOVERED: ${unc.join(", ")}` : "");
  const rest = cov.gaps.filter((g) => !g.includes("UNCOVERED"));
  if (rest.length) line += `\n  ${cov.status === "degraded" ? "DEGRADED" : "gaps"}: ${rest.join("; ").slice(0, 300)}`;
  else if (cov.status === "degraded") line += `\n  DEGRADED: do not conclude "no history" from a miss — use --raw`;
  return line;
}
