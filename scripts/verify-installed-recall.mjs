#!/usr/bin/env node
// Strict post-install proof: bytes, SQLite/FTS, doctor, raw lane, and launchd.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

process.umask(0o077);
const USAGE = "usage: verify-installed-recall.mjs --repo <repository-root> --root <absolute RECALL_HOME> --wrapper <installed recall wrapper>";

function die(message) { throw new Error(String(message)); }
function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!value || !new Set(["--repo", "--root", "--wrapper"]).has(key)) die(USAGE);
    out[key.slice(2)] = value;
  }
  for (const key of ["repo", "root", "wrapper"]) if (!out[key] || !path.isAbsolute(out[key])) die(`${key} must be an absolute path`);
  return out;
}

function shaFile(fp) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(fp, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (let pos = 0; ; ) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n)); pos += n;
    }
  } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}

function requireMode(fp, expected) {
  const mode = fs.statSync(fp).mode & 0o777;
  if (mode !== expected) die(`mode mismatch ${fp}: ${mode.toString(8)} != ${expected.toString(8)}`);
}

function spawnChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 300000, maxBuffer: 4 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) die(`${path.basename(command)} ${args.join(" ")} failed status=${result.status}: ${(result.stderr || result.error?.message || "").slice(0, 300)}`);
  return result;
}

async function verifyInstalled(args) {
  const pairs = [];
  for (const name of fs.readdirSync(path.join(args.repo, "lib")).filter((name) => name.endsWith(".mjs")).sort())
    pairs.push([path.join(args.repo, "lib", name), path.join(args.root, "lib", name), 0o600]);
  for (const name of ["archive.mjs", "recall.mjs"])
    pairs.push([path.join(args.repo, "bin", name), path.join(args.root, "bin", name), 0o700]);
  pairs.push([path.join(args.repo, "integration", "SKILL.md"), path.join(args.root, "integration", "agent-recall", "SKILL.md"), 0o600]);
  for (const [source, installed, mode] of pairs) {
    if (!fs.existsSync(installed) || shaFile(source) !== shaFile(installed)) die(`installed bytes differ: ${installed}`);
    requireMode(installed, mode);
  }
  if ((fs.statSync(args.wrapper).mode & 0o111) === 0) die("installed wrapper is not executable");
  console.log(`INSTALLED_BYTES_PASS files=${pairs.length}`);

  const doctor = spawnChecked(args.wrapper, ["doctor"], { env: { ...process.env, RECALL_HOME: args.root } });
  const requiredDoctor = [/^ok\s+quick_check(?:\s|$)/m, /^ok\s+fts-consistency(?:\s|$)/m, /^ok\s+index gaps\s+—\s+\{\}$/m, /^ok\s+status\s+—\s+ok$/m];
  for (const re of requiredDoctor) if (!re.test(doctor.stdout)) die(`doctor missing ${re}`);

  const sourcePaths = await import(pathToFileURL(path.join(args.repo, "lib", "paths.mjs")).href);
  const dbPath = path.join(args.root, "state", "recall.sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let state;
  try {
    const quickRows = db.prepare("PRAGMA quick_check").all();
    const quick = quickRows.length === 1 ? String(Object.values(quickRows[0])[0]) : "not-ok";
    const gaps = db.prepare("SELECT count(*) AS c FROM index_gaps").get().c;
    const logs = db.prepare("SELECT count(*) AS c FROM files WHERE lower(path) LIKE '%.log'").get().c;
    const events = db.prepare("SELECT count(*) AS c FROM events").get().c;
    const fts = db.prepare("SELECT count(*) AS c FROM events_fts_docsize").get().c;
    const impossible = db.prepare("SELECT count(*) AS c FROM files WHERE offset < 0 OR offset > size OR line < 0").get().c;
    const version = db.prepare("SELECT v FROM meta WHERE k='parserVersion'").get()?.v;
    const lastIndex = db.prepare("SELECT v FROM meta WHERE k='lastIndex'").get()?.v;
    const stats = JSON.parse(db.prepare("SELECT v FROM meta WHERE k='lastIndexStats'").get()?.v || "{}");
    const manifest = JSON.parse(fs.readFileSync(path.join(args.root, "state", "archive-manifest.json"), "utf8"));
    const fresh = Date.parse(lastIndex || "") + 1000 >= Date.parse(manifest?.lastRun?.at || "");
    state = { quick, gaps, logs, events, fts, impossible, version, budgetHit: !!stats.budgetHit, fileErrors: Number(stats.fileErrors || 0), fresh };
  } finally { db.close(); }
  if (state.quick !== "ok" || state.gaps !== 0 || state.logs !== 0 || state.events <= 0 || state.fts !== state.events ||
      state.impossible !== 0 || state.version !== sourcePaths.PARSER_VERSION || state.budgetHit || state.fileErrors !== 0 || !state.fresh)
    die(`SQLite health mismatch: ${JSON.stringify(state)}`);
  console.log(`SQLITE_HEALTH_PASS quick_check=ok index_gaps=0 log_files=0 parserVersion=${state.version} events=${state.events} fts=${state.fts}`);

  const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), "recall-installed-raw-"));
  try {
    const fp = path.join(rawRoot, "archive", "grok", "canary", "g0001.log");
    fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o700 });
    const canary = `recall-raw-canary-${crypto.randomBytes(16).toString("hex")}`;
    fs.writeFileSync(fp, canary + "\n", { mode: 0o600 });
    const before = shaFile(fp);
    const raw = spawnChecked(args.wrapper, ["search", canary, "--raw", "--all"], { env: { ...process.env, RECALL_HOME: rawRoot } });
    if (!raw.stdout.includes(canary) || !raw.stdout.includes("g0001.log") || shaFile(fp) !== before) die("installed raw lane failed or changed its artifact");
    console.log("RAW_LANE_PASS installed-runtime=true artifact=g0001.log");
  } finally { fs.rmSync(rawRoot, { recursive: true, force: true }); }

  const launchd = spawnSync("launchctl", ["print", `gui/${process.getuid()}/local.agent-recall.sync`], { encoding: "utf8", timeout: 10000 });
  if (launchd.error || launchd.status !== 0) die("launchd job is not loaded");
  console.log("DOCTOR_PASS status=ok");
  console.log("INSTALLED_RECALL_PASS");
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); process.exit(0); }
  await verifyInstalled(args);
} catch (error) {
  console.error(`INSTALLED_RECALL_FAIL: ${String(error?.message ?? error).slice(0, 500)}`);
  process.exit(1);
}
