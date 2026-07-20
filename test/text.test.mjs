import test from "node:test";
import assert from "node:assert/strict";
import { clean, redact, display, terminalLine } from "../lib/text.mjs";

const ESC = "\x1b";
const BEL = "\x07";

// ---------- redact: every pattern class ----------

test("redacts private key blocks (RSA/EC/OPENSSH/plain/PGP)", () => {
  const body = "MIIEpAIBAAKCAQEA7changeme\nZm9vYmFyYmF6\n";
  for (const label of [
    "RSA PRIVATE KEY",
    "EC PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
    "PRIVATE KEY",
    "ENCRYPTED PRIVATE KEY",
    "PGP PRIVATE KEY BLOCK",
  ]) {
    const s = `before\n-----BEGIN ${label}-----\n${body}-----END ${label}-----\nafter`;
    const out = redact(s);
    assert.ok(out.includes("[redacted:private-key]"), label);
    assert.ok(!out.includes("MIIEpAIBAA"), `${label} body leaked`);
    assert.ok(out.includes("before") && out.includes("after"));
  }
});

test("private key block wins over generic patterns inside it", () => {
  const s = "-----BEGIN RSA PRIVATE KEY-----\nAKIAIOSFODNN7EXAMPLE\nsk-abcdefabcdefabcdef\n-----END RSA PRIVATE KEY-----";
  assert.equal(redact(s), "[redacted:private-key]");
});

test("redacts sk-/rk-/pk- style keys", () => {
  assert.equal(
    redact("key: sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12"),
    "key: [redacted:api-key]",
  );
  assert.ok(redact("rk-live-1234567890abcdef1234").includes("[redacted:api-key]"));
  assert.ok(redact("pk-test-1234567890abcdef1234").includes("[redacted:api-key]"));
});

test("redacts AWS access key ids", () => {
  assert.equal(redact("aws AKIAIOSFODNN7EXAMPLE ok"), "aws [redacted:aws-key] ok");
});

test("redacts GitHub tokens (all prefixes)", () => {
  for (const p of ["ghp", "gho", "ghu", "ghs", "ghr"]) {
    const out = redact(`push with ${p}_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`);
    assert.equal(out, "push with [redacted:github-token]", p);
  }
  assert.equal(
    redact("github_pat_11ABCDEFG0_abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGH"),
    "[redacted:github-token]",
  );
});

test("redacts Slack tokens", () => {
  for (const p of ["xoxb", "xoxa", "xoxp", "xoxr", "xoxs"]) {
    const out = redact(`${p}-123456789012-123456789012-AbCdEfGhIjKlMnOpQrStUvWx`);
    assert.equal(out, "[redacted:slack-token]", p);
  }
});

test("redacts JWTs", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQsswc";
  assert.equal(redact(`jwt=${jwt}`), "jwt=[redacted:jwt]");
});

test("redacts bearer tokens", () => {
  const out = redact("Authorization: Bearer AbCdEf0123456789TokenValue");
  assert.equal(out, "Authorization: Bearer [redacted:bearer]");
});

test("redacts password/secret/token/api_key assignments", () => {
  assert.equal(redact('password = "hunter2secret"'), "password=[redacted:credential]");
  assert.equal(redact("export API_KEY=abc123def456"), "export API_KEY=[redacted:credential]");
  assert.equal(redact("secret: supersecretvalue"), "secret=[redacted:credential]");
  assert.equal(redact("token='sess_0aB1cD2eF3'"), "token=[redacted:credential]");
  assert.equal(redact("client_secret=Zx9y8W7v6U5t"), "client_secret=[redacted:credential]");
  assert.equal(redact("access_token: ya29abcdefgh"), "access_token=[redacted:credential]");
});

test("redacts emails", () => {
  assert.equal(
    redact("mail john.doe+test@sub.example.co.uk now"),
    "mail [redacted:email] now",
  );
});

test("redacts US phone patterns", () => {
  assert.equal(redact("call (303) 906-0715 today"), "call [redacted:phone] today");
  assert.equal(redact("call 303-906-0715"), "call [redacted:phone]");
  assert.equal(redact("call 303.906.0715"), "call [redacted:phone]");
  assert.equal(redact("call +1 303 906 0715"), "call [redacted:phone]");
  assert.equal(redact("(303)906-0715"), "[redacted:phone]");
});

// ---------- redact: false-positive guards ----------

test("leaves UUIDs alone", () => {
  const s = "session abf18dd9-111f-4ab5-ab89-00b2e570bdf4 resumed";
  assert.equal(redact(s), s);
});

test("leaves code snippets alone", () => {
  for (const s of [
    "const token = process.env.TOKEN;",
    "const apiKeyName = getKey();",
    "if (secret) { return token; }",
    "password: null",
    "task-runner and risk-model and pkg-config are fine",
    "asterisk-marked entries in the skill-list",
  ]) {
    assert.equal(redact(s), s);
  }
});

test("leaves normal prose, hashes, dates, timestamps alone", () => {
  for (const s of [
    "We minted new tokens for the parser yesterday.",
    "commit 9803797 fixed it",
    "released 2026-07-16T01-03-29-506Z_019f6873",
    "the password is stored elsewhere",
    "eyJust kidding, not a jwt",
    "beard trimmer instructions",
    "meeting at 12:15-14:15 on Sunday",
  ]) {
    assert.equal(redact(s), s);
  }
});

// ---------- clean ----------

test("clean strips raw ESC / ANSI sequence", () => {
  const out = clean(`a${ESC}[31mred${ESC}[0mb`);
  assert.ok(!out.includes(ESC));
  assert.ok(out.includes("red"));
});

test("clean strips OSC 8 hyperlink control bytes", () => {
  const out = clean(`${ESC}]8;;https://example.com${BEL}link${ESC}]8;;${BEL}`);
  assert.ok(!out.includes(ESC) && !out.includes(BEL));
  assert.ok(out.includes("link"));
});

test("clean strips bidi override and isolate marks", () => {
  const out = clean("a\u202Egnp.exe\u202Cb \u2066x\u2069 \u200Ey\u200F");
  for (const c of ["\u202E", "\u202C", "\u2066", "\u2069", "\u200E", "\u200F"]) {
    assert.ok(!out.includes(c), `U+${c.codePointAt(0).toString(16)}`);
  }
  assert.ok(out.includes("gnp.exe"));
});

test("clean keeps newline and tab, strips other C0/C1/DEL", () => {
  assert.equal(clean("a\nb\tc"), "a\nb\tc");
  assert.equal(clean("a\x00b\x08c\x7fd\x9be"), "a b c d e");
  assert.equal(clean("crlf\r\n"), "crlf \n"); // \r is C0, not exempted
});

// ---------- terminalLine ----------

test("terminalLine collapses tabs/newlines/line separators to single spaces", () => {
  assert.equal(terminalLine("a\n\nb\t\tc"), "a b c");
  assert.equal(terminalLine("x\u2028y\u2029z"), "x y z");
  assert.equal(terminalLine("one line"), "one line");
});

test("terminalLine strips control chars via clean and leaves no line breaks", () => {
  const out = terminalLine(`a${ESC}[31m\nb`);
  assert.ok(!out.includes(ESC) && !out.includes("\n"), out);
  assert.ok(!/[\t\n\r\u2028\u2029]/.test(terminalLine("evil\r\npayload\u2028here")));
});

// ---------- display ----------

test("display composes clean then redact", () => {
  const out = display(`${ESC}[1m token=abcd1234efgh ${ESC}[0m (303) 906-0715`);
  assert.ok(!out.includes(ESC));
  assert.ok(out.includes("token=[redacted:credential]"));
  assert.ok(out.includes("[redacted:phone]"));
});

test("clean unmasks nothing redact needs: control chars split hidden tokens", () => {
  // an ESC jammed inside would otherwise break the word boundary for "token"
  const out = display(`x${ESC}token=abcd1234efgh`);
  assert.ok(out.includes("token=[redacted:credential]"));
});
