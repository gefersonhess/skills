#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for pure helpers exported from pipeline-status.ts:
//   Phase 4A: shellQuote, resumeSessionName, manualResumeCommand
//   Phase 4B: planResumeAction (pure decision planner)
// Also checks static presence of tmux/dispatch paths in the extension.
//
// Run: node tests/pipeline/test-pipeline-resume-extension.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const extFile = path.join(repoRoot, "extensions", "pipeline-status.ts");

// ── Helpers loaded via node --experimental-strip-types ────────────────────────
// We need to import the exported helpers from pipeline-status.ts.
// Since it's TypeScript and uses `export function`, we spawn node with strip-types.
// The helpers are pure functions with no side effects.

let shellQuote, resumeSessionName, manualResumeCommand;

// ── Subprocess helper: call planResumeAction with a serialised input ─────────
function callAppendRightAlignedHint(line, hint, width, fallbackSeparator) {
  const fallbackArg = fallbackSeparator === undefined ? "" : `, ${JSON.stringify(fallbackSeparator)}`;
  const result = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module"],
    {
      input: `
import { appendRightAlignedHint, visibleTextLength } from ${JSON.stringify(extFile)};
const rendered = appendRightAlignedHint(${JSON.stringify(line)}, ${JSON.stringify(hint)}, ${JSON.stringify(width)}${fallbackArg});
process.stdout.write(JSON.stringify({ rendered, visible: visibleTextLength(rendered) }));
`,
      encoding: "utf8",
      timeout: 10000,
    }
  );
  return JSON.parse(result);
}

function callPlanResumeAction(input) {
  const result = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module"],
    {
      input: `
import { planResumeAction } from ${JSON.stringify(extFile)};
const input = ${JSON.stringify(input)};
process.stdout.write(JSON.stringify(planResumeAction(input)));
`,
      encoding: "utf8",
      timeout: 10000,
    }
  );
  return JSON.parse(result);
}

try {
  // Use a subprocess to import the TS module and serialize results for each test case.
  // This avoids needing to replicate the logic here.
  const result = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
    ],
    {
      input: `
import { shellQuote, resumeSessionName, manualResumeCommand } from ${JSON.stringify(extFile)};
const cases = {
  shellQuote_simple: shellQuote("/path/to/script.sh"),
  shellQuote_spaces: shellQuote("/path/with spaces/script.sh"),
  shellQuote_single_quote: shellQuote("/path/it's-here/script.sh"),
  shellQuote_no_special: shellQuote("/simple"),
  resumeSessionName_basic: resumeSessionName("abc-123"),
  resumeSessionName_special_chars: resumeSessionName("my pipeline/id:test"),
  resumeSessionName_long: resumeSessionName("a".repeat(60)),
  resumeSessionName_prefix: resumeSessionName("pipe-1"),
  manualResumeCommand_both: manualResumeCommand("/usr/local/bin/pipeline.sh", "/tmp/status.json"),
  manualResumeCommand_no_script: manualResumeCommand(undefined, "/tmp/status.json"),
  manualResumeCommand_no_status: manualResumeCommand("/usr/local/bin/pipeline.sh", undefined),
  manualResumeCommand_both_undefined: manualResumeCommand(undefined, undefined),
};
process.stdout.write(JSON.stringify(cases));
`,
      encoding: "utf8",
      timeout: 10000,
    }
  );
  const data = JSON.parse(result);
  shellQuote = (arg) => {
    // Map test-case key to result
    const key = arg === "/path/to/script.sh" ? "shellQuote_simple"
               : arg === "/path/with spaces/script.sh" ? "shellQuote_spaces"
               : arg === "/path/it's-here/script.sh" ? "shellQuote_single_quote"
               : arg === "/simple" ? "shellQuote_no_special"
               : null;
    if (key) return data[key];
    throw new Error(`Unmapped shellQuote arg: ${arg}`);
  };
  // Store resolved values for direct assertions
  Object.assign(globalThis, { _helperData: data });
} catch (e) {
  console.error("FATAL: could not load helpers from pipeline-status.ts:", e.message);
  process.exit(1);
}

// ── Minimal test harness ──────────────────────────────────────────────────────

let PASS = 0;
let FAIL = 0;

function ok(label) {
  console.log(`  ✓ ${label}`);
  PASS++;
}

function fail(label, msg = "") {
  console.log(`  ✗ ${label}${msg ? " — " + msg : ""}`);
  FAIL++;
}

function assertEqual(label, expected, actual) {
  if (expected === actual) {
    ok(label);
  } else {
    fail(label, `expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)}`);
  }
}

function assertIncludes(label, haystack, needle) {
  if (haystack.includes(needle)) {
    ok(label);
  } else {
    fail(label, `expected ${JSON.stringify(needle)} in ${JSON.stringify(haystack)}`);
  }
}

function assertNotIncludes(label, haystack, needle) {
  if (!haystack.includes(needle)) {
    ok(label);
  } else {
    fail(label, `expected ${JSON.stringify(needle)} NOT in ${JSON.stringify(haystack)}`);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const d = globalThis._helperData;

// shellQuote
console.log("\n=== shellQuote ===");
assertEqual(
  "simple path: wrapped in single quotes",
  "'/path/to/script.sh'",
  d.shellQuote_simple
);
assertEqual(
  "path with spaces: wrapped (spaces preserved inside quotes)",
  "'/path/with spaces/script.sh'",
  d.shellQuote_spaces
);
// Single quote in path: uses '\'' pattern
assertEqual(
  "path with single-quote: exact shell-escaped form",
  "'/path/it'\\''s-here/script.sh'",
  d.shellQuote_single_quote
);
// The result must start with ' for shell safety
{
  const q = d.shellQuote_single_quote;
  if (q.startsWith("'")) {
    ok("shellQuote with single-quote: result starts with single-quote");
  } else {
    fail("shellQuote with single-quote: result starts with single-quote", `got: ${JSON.stringify(q)}`);
  }
}
assertEqual(
  "simple path no special: single-quote wrapped",
  "'/simple'",
  d.shellQuote_no_special
);

// resumeSessionName
console.log("\n=== resumeSessionName ===");
assertEqual(
  "basic id: prefixed with resume-",
  "resume-abc-123",
  d.resumeSessionName_basic
);
assertIncludes(
  "special chars: starts with resume-",
  d.resumeSessionName_special_chars,
  "resume-"
);
assertNotIncludes(
  "special chars: no slash in session name",
  d.resumeSessionName_special_chars,
  "/"
);
assertNotIncludes(
  "special chars: no colon in session name",
  d.resumeSessionName_special_chars,
  ":"
);
// Bounded: 'resume-' (7 chars) + max 40 = 47 chars
{
  const len = d.resumeSessionName_long.length;
  if (len <= 48) {
    ok("long id: session name length bounded (≤48)");
  } else {
    fail("long id: session name length bounded (≤48)", `length was ${len}`);
  }
}
assertEqual(
  "pipe-1 id: deterministic session name",
  "resume-pipe-1",
  d.resumeSessionName_prefix
);

// manualResumeCommand
console.log("\n=== manualResumeCommand ===");
assertIncludes(
  "both present: contains script path quoted",
  d.manualResumeCommand_both,
  "'/usr/local/bin/pipeline.sh'"
);
assertIncludes(
  "both present: contains --resume flag",
  d.manualResumeCommand_both,
  "--resume"
);
assertIncludes(
  "both present: contains status file path quoted",
  d.manualResumeCommand_both,
  "'/tmp/status.json'"
);
assertEqual(
  "no script: returns empty string",
  "",
  d.manualResumeCommand_no_script
);
assertEqual(
  "no status: returns empty string",
  "",
  d.manualResumeCommand_no_status
);
assertEqual(
  "both undefined: returns empty string",
  "",
  d.manualResumeCommand_both_undefined
);

// pipelineStatusHelpText
console.log("\n=== pipelineStatusHelpText ===");
function callPipelineStatusHelpText() {
  const result = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module"],
    {
      input: `
import { pipelineStatusHelpText } from ${JSON.stringify(extFile)};
process.stdout.write(JSON.stringify(pipelineStatusHelpText()));
`,
      encoding: "utf8",
      timeout: 10000,
    }
  );
  return JSON.parse(result);
}
{
  const help = callPipelineStatusHelpText();
  assertIncludes("help: usage header", help, "/pipeline-status usage:");
  for (const action of ["show", "list", "hide", "pause", "resume", "skip", "abort", "dismiss", "log"]) {
    assertIncludes(`help: includes ${action}`, help, action);
  }
  assertIncludes("help: includes --help", help, "--help");
  assertIncludes("help: includes shortcut /pipeline-pause", help, "/pipeline-pause");
  assertIncludes("help: includes shortcut /pipeline-hide", help, "/pipeline-hide");
  assertIncludes("help: includes shortcut /pipeline-show", help, "/pipeline-show");
  assertIncludes("help: documents pN handles", help, "p1/p2");
  assertIncludes("help: documents unique id prefixes", help, "unique pipeline id prefix");
}

// Static assertions on extension source
console.log("\n=== Static source checks (pipeline-status.ts) ===");
const src = readFileSync(extFile, "utf8");

assertIncludes(
  "source: dead-pid branch uses tmux new-session",
  src,
  "new-session"
);
assertIncludes(
  "source: dead-pid branch checks tmux availability",
  src,
  "which"
);
assertIncludes(
  "source: dead-pid branch checks has-session",
  src,
  "has-session"
);
assertIncludes(
  "source: resumeSessionName is used in resumePipeline",
  src,
  "resumeSessionName("
);
assertIncludes(
  "source: shellQuote is used to build tmux command",
  src,
  "shellQuote("
);
assertIncludes(
  "source: manualResumeCommand is used for fallback notifications",
  src,
  "manualResumeCommand("
);
assertIncludes(
  "source: pidAlive=false path does NOT write control_file",
  src,
  "Dead PID: attempt restart only after precondition checks"
);
assertIncludes(
  "source: resume_supported check present",
  src,
  "resume_supported !== true"
);
assertIncludes(
  "source: absolute path guard for script_file present",
  src,
  'startsWith("/")'
);
assertNotIncludes(
  "source: compact widget does not render a heading",
  src,
  "── Pipeline ──"
);
assertIncludes(
  "source: compact item timer label is used",
  src,
  'keyValue(theme, "item", pipeline.issueElapsed)'
);
assertIncludes(
  "source: compact total timer label is used",
  src,
  'keyValue(theme, "total", pipeline.totalElapsed)'
);
assertIncludes(
  "source: compact status emphasizes key values with theme text token",
  src,
  'return color(theme, "text", text)'
);
assertIncludes(
  "source: /pipeline-status --help is handled before refresh",
  src,
  "if (isHelpAction(action))"
);
assertIncludes(
  "source: /pipeline-status hide is handled before refresh",
  src,
  'if (action === "hide")'
);
assertIncludes(
  "source: render clears UI while statusHidden",
  src,
  "if (statusHidden || pipelines.length === 0)"
);
assertIncludes(
  "source: /pipeline-hide shortcut is registered",
  src,
  'pi.registerCommand("pipeline-hide"'
);
assertIncludes(
  "source: /pipeline-show shortcut is registered",
  src,
  'pi.registerCommand("pipeline-show"'
);
assertIncludes(
  "source: compact widget dims /pipeline-status hint",
  src,
  'color(theme, "dim", "/pipeline-status")'
);
assertIncludes(
  "source: widget uses width-aware renderer",
  src,
  "render(width: number): string[]"
);
assertIncludes(
  "source: compact widget right-aligns /pipeline-status hint",
  src,
  "appendRightAlignedHint(line, color(theme, \"dim\", \"/pipeline-status\"), options.width"
);
assertNotIncludes(
  "source: compact widget does not show verbose controls label",
  src,
  'label(theme, "controls:")'
);
assertNotIncludes(
  "source: compact widget does not render verbose controls helper",
  src,
  "compactControls"
);
assertIncludes(
  "source: short pN handles are available",
  src,
  "function pipelineHandle"
);

console.log("\n=== compact widget right-aligned hint ===");
{
  const result = callAppendRightAlignedHint("● #199 bot", "\x1b[2m/pipeline-status\x1b[0m", 40, " · ");
  assertEqual("right-aligned hint: visible width matches widget width", 40, result.visible);
  assertIncludes("right-aligned hint: preserves dimmed hint", result.rendered, "\x1b[2m/pipeline-status\x1b[0m");
  assertIncludes("right-aligned hint: pads before hint", result.rendered, "          \x1b[2m/pipeline-status");
}
{
  const result = callAppendRightAlignedHint("● #199 bot", "/pipeline-status", 10, " · ");
  assertEqual("narrow width: falls back to separator", "● #199 bot · /pipeline-status", result.rendered);
}

assertIncludes(
  "source: tmux attach attach hint in spawn-success message",
  src,
  "tmux attach -t"
);
assertIncludes(
  "source: already-running session guard present",
  src,
  "a resume session is already running"
);
assertIncludes(
  "source: steer() special-cases resume before control-file write",
  src,
  'command === "resume"'
);
assertIncludes(
  "source: exported shellQuote",
  src,
  "export function shellQuote"
);
assertIncludes(
  "source: exported resumeSessionName",
  src,
  "export function resumeSessionName"
);
assertIncludes(
  "source: exported manualResumeCommand",
  src,
  "export function manualResumeCommand"
);
assertIncludes(
  "source: exported planResumeAction",
  src,
  "export function planResumeAction"
);
assertIncludes(
  "source: exported classifyState",
  src,
  "export function classifyState"
);
assertIncludes(
  "source: exported elapsedIssue",
  src,
  "export function elapsedIssue"
);
assertIncludes(
  "source: resumePipeline calls planResumeAction(",
  src,
  "planResumeAction("
);
assertIncludes(
  "source: tmux new-session still present (runtime path)",
  src,
  "new-session"
);
assertIncludes(
  "source: tmux availability check still present (runtime path)",
  src,
  "which"
);
assertIncludes(
  "source: has-session still present (runtime path)",
  src,
  "has-session"
);

// ── planResumeAction behavior tests ─────────────────────────────────────
// These do NOT touch filesystem, tmux, or process liveness.
console.log("\n=== planResumeAction — live PID (control-file-write) ===");

// Invariant: only paused + pidAlive + absolute controlFile -> control-file-write
{
  const a = callPlanResumeAction({
    pipelineId: "p1", state: "paused", pidAlive: true,
    controlFile: "/tmp/ctrl", statusFile: "/tmp/s.json",
  });
  assertEqual("paused+live+absolute controlFile -> control-file-write", "control-file-write", a.type);
  assertEqual("control-file-write: controlFile matches input", "/tmp/ctrl", a.controlFile);
}

// Live PID ignores missing status / schema / resume_supported / checkpoint
{
  const a = callPlanResumeAction({
    pipelineId: "p1", state: "paused", pidAlive: true,
    controlFile: "/tmp/ctrl", statusFile: "/tmp/s.json",
    // no status at all
  });
  assertEqual("paused+live+no status -> still control-file-write", "control-file-write", a.type);
}
{
  const a = callPlanResumeAction({
    pipelineId: "p1", state: "paused", pidAlive: true,
    controlFile: "/tmp/ctrl", statusFile: "/tmp/s.json",
    status: { schema_version: 1, resume_supported: false, checkpoint: null },
  });
  assertEqual("paused+live+v1 status -> still control-file-write (live ignores schema)", "control-file-write", a.type);
}

// Live PID + empty controlFile -> refuse
{
  const a = callPlanResumeAction({
    pipelineId: "p1", state: "paused", pidAlive: true,
    controlFile: "", statusFile: "/tmp/s.json",
  });
  assertEqual("paused+live+empty controlFile -> refuse", "refuse", a.type);
  assertIncludes("refuse message mentions controlFile is missing or not absolute", a.message, "controlFile is missing or not absolute");
}

// Live PID + relative controlFile -> refuse
{
  const a = callPlanResumeAction({
    pipelineId: "p1", state: "paused", pidAlive: true,
    controlFile: "relative/ctrl", statusFile: "/tmp/s.json",
  });
  assertEqual("paused+live+relative controlFile -> refuse", "refuse", a.type);
  assertIncludes("refuse message mentions controlFile is missing or not absolute", a.message, "controlFile is missing or not absolute");
}

console.log("\n=== planResumeAction — dead PID (tmux-restart) ===");

const goodDeadInput = {
  pipelineId: "pipe-1",
  state: "paused",
  pidAlive: false,
  controlFile: "/tmp/ctrl",
  statusFile: "/tmp/status.json",
  status: {
    schema_version: 2,
    resume_supported: true,
    checkpoint: "between-issues",
    script_file: "/usr/local/bin/pipeline.sh",
  },
};

// All preconditions met -> tmux-restart
{
  const a = callPlanResumeAction(goodDeadInput);
  assertEqual("dead+all preconditions -> tmux-restart", "tmux-restart", a.type);
  assertEqual("tmux-restart: deterministic sessionName", "resume-pipe-1", a.sessionName);
  assertIncludes("tmux-restart: shellCmd contains script quoted", a.shellCmd, "'/usr/local/bin/pipeline.sh'");
  assertIncludes("tmux-restart: shellCmd contains --resume", a.shellCmd, "--resume");
  assertIncludes("tmux-restart: shellCmd contains statusFile quoted", a.shellCmd, "'/tmp/status.json'");
  assertIncludes("tmux-restart: shellCmd ends with exec bash", a.shellCmd, "exec bash");
  assertEqual("tmux-restart: scriptFile in action", "/usr/local/bin/pipeline.sh", a.scriptFile);
  assertEqual("tmux-restart: statusFile in action", "/tmp/status.json", a.statusFile);
}

console.log("\n=== planResumeAction — dead PID precondition refusals ===");

// No status
{
  const a = callPlanResumeAction({ ...goodDeadInput, status: undefined });
  assertEqual("dead+no status -> refuse", "refuse", a.type);
  assertIncludes("refuse: missing status message", a.message, "missing or unreadable");
}

// schema_version missing (treated as v1)
{
  const a = callPlanResumeAction({ ...goodDeadInput, status: { ...goodDeadInput.status, schema_version: undefined } });
  assertEqual("dead+no schema_version -> refuse", "refuse", a.type);
  assertIncludes("refuse: schema message", a.message, "schema_version");
  assertIncludes("refuse: mentions v1/unsupported", a.message, "v1/unsupported");
}

// schema_version === 1
{
  const a = callPlanResumeAction({ ...goodDeadInput, status: { ...goodDeadInput.status, schema_version: 1 } });
  assertEqual("dead+schema_version=1 -> refuse", "refuse", a.type);
  assertIncludes("refuse: schema v1 message", a.message, "v1/unsupported");
}

// resume_supported false
{
  const a = callPlanResumeAction({ ...goodDeadInput, status: { ...goodDeadInput.status, resume_supported: false } });
  assertEqual("dead+resume_supported=false -> refuse", "refuse", a.type);
  assertIncludes("refuse: resume_supported not true", a.message, "resume_supported");
}

// resume_supported missing
{
  const a = callPlanResumeAction({ ...goodDeadInput, status: { ...goodDeadInput.status, resume_supported: undefined } });
  assertEqual("dead+resume_supported=undefined -> refuse", "refuse", a.type);
  assertIncludes("refuse: resume_supported not true (missing)", a.message, "resume_supported");
}

// resume_supported string "true" (not strict boolean)
{
  const a = callPlanResumeAction({ ...goodDeadInput, status: { ...goodDeadInput.status, resume_supported: "true" } });
  assertEqual("dead+resume_supported=string-true -> refuse (strict true required)", "refuse", a.type);
}

// checkpoint missing
{
  const a = callPlanResumeAction({ ...goodDeadInput, status: { ...goodDeadInput.status, checkpoint: undefined } });
  assertEqual("dead+checkpoint=missing -> refuse", "refuse", a.type);
  assertIncludes("refuse: mentions between-issues", a.message, "between-issues");
}

// checkpoint null
{
  const a = callPlanResumeAction({ ...goodDeadInput, status: { ...goodDeadInput.status, checkpoint: null } });
  assertEqual("dead+checkpoint=null -> refuse", "refuse", a.type);
  assertIncludes("refuse: mentions between-issues (null)", a.message, "between-issues");
}

// checkpoint unsupported string
{
  const a = callPlanResumeAction({ ...goodDeadInput, status: { ...goodDeadInput.status, checkpoint: "mid-issue" } });
  assertEqual("dead+checkpoint=mid-issue -> refuse", "refuse", a.type);
  assertIncludes("refuse: mentions between-issues (wrong)", a.message, "between-issues");
  assertIncludes("refuse: mentions actual checkpoint value", a.message, "mid-issue");
}

// relative script_file
{
  const a = callPlanResumeAction({ ...goodDeadInput, status: { ...goodDeadInput.status, script_file: "relative/path.sh" } });
  assertEqual("dead+relative script_file -> refuse", "refuse", a.type);
  assertIncludes("refuse: script_file not absolute", a.message, "script_file");
}

// missing script_file
{
  const a = callPlanResumeAction({ ...goodDeadInput, status: { ...goodDeadInput.status, script_file: undefined } });
  assertEqual("dead+missing script_file -> refuse", "refuse", a.type);
  assertIncludes("refuse: script_file missing", a.message, "script_file");
}

// relative statusFile
{
  const a = callPlanResumeAction({ ...goodDeadInput, statusFile: "relative/status.json" });
  assertEqual("dead+relative statusFile -> refuse", "refuse", a.type);
  assertIncludes("refuse: statusFile not absolute", a.message, "statusFile");
}

// missing statusFile
{
  const a = callPlanResumeAction({ ...goodDeadInput, statusFile: "" });
  assertEqual("dead+empty statusFile -> refuse", "refuse", a.type);
  assertIncludes("refuse: statusFile missing", a.message, "statusFile");
}

// dead+all-good: manualCommand not present (tmux-restart doesn't need it)
{
  const a = callPlanResumeAction(goodDeadInput);
  if (a.type === "tmux-restart" && a.manualCommand === undefined) {
    ok("tmux-restart: no manualCommand field");
  } else if (a.type === "tmux-restart") {
    ok("tmux-restart: action type correct (manualCommand field presence optional)");
  } else {
    fail("tmux-restart: expected tmux-restart", `got ${a.type}`);
  }
}

console.log("\n=== planResumeAction — non-paused states refuse ===");

for (const state of ["running", "completed", "crashed", "unknown", "starting"]) {
  const a = callPlanResumeAction({
    pipelineId: "p1", state, pidAlive: false,
    controlFile: "/tmp/ctrl", statusFile: "/tmp/s.json",
  });
  assertEqual(`state=${state} -> refuse`, "refuse", a.type);
  assertIncludes(`state=${state} refuse: message mentions state`, a.message, state);
}

// ── classifyState behavioral tests ─────────────────────────────────────────────
// Critical invariant: a dead paused pipeline stays "paused", never "crashed".
// These tests exercise the exported pure helper directly via a subprocess.
console.log("\n=== classifyState — core invariants ===");

function callClassifyState(rawState, pidAlive, hasStatus) {
  const result = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module"],
    {
      input: `
import { classifyState } from ${JSON.stringify(extFile)};
process.stdout.write(JSON.stringify(classifyState(${JSON.stringify(rawState)}, ${JSON.stringify(pidAlive)}, ${JSON.stringify(hasStatus)})));
`,
      encoding: "utf8",
      timeout: 10000,
    }
  );
  return JSON.parse(result);
}

// (a) Dead paused pipeline is still "paused", not "crashed"
{
  const result = callClassifyState("paused", false, true);
  assertEqual(
    "classifyState(paused, pidAlive=false, hasStatus=true) === paused (dead paused stays paused)",
    "paused",
    result
  );
}

// (b) Live paused pipeline is still "paused"
{
  const result = callClassifyState("paused", true, true);
  assertEqual(
    "classifyState(paused, pidAlive=true, hasStatus=true) === paused (live paused stays paused)",
    "paused",
    result
  );
}

// (c) Dead running pipeline is "crashed"
{
  const result = callClassifyState("running", false, true);
  assertEqual(
    "classifyState(running, pidAlive=false, hasStatus=true) === crashed (dead running is crashed)",
    "crashed",
    result
  );
}

// (d) No status + pid dead -> "crashed"
{
  const result = callClassifyState(undefined, false, false);
  assertEqual(
    "classifyState(undefined, pidAlive=false, hasStatus=false) === crashed (no status, no pid)",
    "crashed",
    result
  );
}

// (d) No status + pid alive -> "starting"
{
  const result = callClassifyState(undefined, true, false);
  assertEqual(
    "classifyState(undefined, pidAlive=true, hasStatus=false) === starting (no status, pid alive)",
    "starting",
    result
  );
}

// Additional guard: live running is still "running" (not crashed)
{
  const result = callClassifyState("running", true, true);
  assertEqual(
    "classifyState(running, pidAlive=true, hasStatus=true) === running (live running stays running)",
    "running",
    result
  );
}

// ── Compact status icon/color helpers ────────────────────────────────────────
console.log("\n=== Compact status icon/color helpers ===");

function callStatePresentation(state) {
  const result = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module"],
    {
      input: `
import { stateIndicator, stateColorName } from ${JSON.stringify(extFile)};
process.stdout.write(JSON.stringify({ icon: stateIndicator(${JSON.stringify(state)}), color: stateColorName(${JSON.stringify(state)}) }));
`,
      encoding: "utf8",
      timeout: 10000,
    }
  );
  return JSON.parse(result);
}

for (const [state, icon, color] of [
  ["running", "●", "accent"],
  ["starting", "●", "accent"],
  ["paused", "⏸", "warning"],
  ["completed", "✓", "success"],
  ["aborted", "■", "error"],
  ["killed", "■", "error"],
  ["crashed", "■", "error"],
  ["unknown", "○", "muted"],
]) {
  const result = callStatePresentation(state);
  assertEqual(`${state}: icon`, icon, result.icon);
  assertEqual(`${state}: color`, color, result.color);
}

// ── Phase 5H: Static checks for resume_error / formatResumeError ──────────────
console.log("\n=== Static source checks — Phase 5H (resume_error / formatResumeError) ===");

assertIncludes(
  "source: resume_error?: unknown field in PipelineStatus",
  src,
  "resume_error?: unknown"
);
assertIncludes(
  "source: export function formatResumeError present",
  src,
  "export function formatResumeError"
);
assertIncludes(
  "source: formatResumeError called with pipeline.status?.resume_error",
  src,
  "formatResumeError(pipeline.status?.resume_error)"
);
assertIncludes(
  "source: pipeline.state === blocked guard in widgetLines",
  src,
  'pipeline.state === "blocked"'
);
assertNotIncludes(
  "source: footer status renderer has been removed",
  src,
  "function footerText("
);
assertIncludes(
  "source: render clears the footer status slot before setting widget",
  src,
  "ctx.ui.setStatus(STATUS_KEY, undefined);\n\t\tctx.ui.setWidget"
);

// ── Phase 5H: formatResumeError pure helper tests ───────────────────────────
console.log("\n=== formatResumeError pure helper ===");

function callFormatResumeError(value, max) {
  const maxArg = max === undefined ? "" : `, ${JSON.stringify(max)}`;
  const result = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module"],
    {
      input: `
import { formatResumeError } from ${JSON.stringify(extFile)};
const value = ${JSON.stringify(value)};
process.stdout.write(JSON.stringify(formatResumeError(value${maxArg})));
`,
      encoding: "utf8",
      timeout: 10000,
    }
  );
  return JSON.parse(result);
}

function callFormatResumeErrorRaw(valueExpr, max) {
  const maxArg = max === undefined ? "" : `, ${JSON.stringify(max)}`;
  const result = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module"],
    {
      input: `
import { formatResumeError } from ${JSON.stringify(extFile)};
const value = ${valueExpr};
process.stdout.write(JSON.stringify(formatResumeError(value${maxArg})));
`,
      encoding: "utf8",
      timeout: 10000,
    }
  );
  return JSON.parse(result);
}

// normal string unchanged
{
  const r = callFormatResumeError("config hash mismatch");
  assertEqual("normal string: unchanged", "config hash mismatch", r);
}

// trims leading/trailing whitespace
{
  const r = callFormatResumeError("  trimmed  ");
  assertEqual("string with surrounding spaces: trimmed", "trimmed", r);
}

// newline, tab, CR collapsed to spaces then collapsed+trimmed
{
  const r = callFormatResumeError("line1\nline2\ttab\rcarriage");
  assertEqual("newline/tab/CR: collapsed to single spaces", "line1 line2 tab carriage", r);
}

// ANSI escape: \x1b (0x1B, within \x00-\x1F) is control -> space; multiple controls collapse
{
  const r = callFormatResumeError("\x1b[31mred\x1b[0m");
  assertEqual("ANSI \\x1b[31mred\\x1b[0m => [31mred [0m", "[31mred [0m", r);
}

// NUL/control-only -> null
{
  const r = callFormatResumeError("\x00\x01\x02");
  assertEqual("control-only string: null", null, r);
}

// non-string: undefined -> null
{ const r = callFormatResumeErrorRaw("undefined"); assertEqual("undefined -> null", null, r); }

// non-string: null -> null
{ const r = callFormatResumeErrorRaw("null"); assertEqual("null -> null", null, r); }

// non-string: number -> null
{ const r = callFormatResumeErrorRaw("42"); assertEqual("number 42 -> null", null, r); }

// non-string: boolean -> null
{ const r = callFormatResumeErrorRaw("true"); assertEqual("boolean true -> null", null, r); }

// non-string: object -> null
{ const r = callFormatResumeErrorRaw('({msg: "err"})'); assertEqual("object -> null", null, r); }

// non-string: array -> null
{ const r = callFormatResumeErrorRaw('["err"]'); assertEqual("array -> null", null, r); }

// empty string -> null
{
  const r = callFormatResumeError("");
  assertEqual("empty string -> null", null, r);
}

// whitespace-only -> null
{
  const r = callFormatResumeError("   ");
  assertEqual("whitespace-only string -> null", null, r);
}

// exactly 160 chars: unchanged
{
  const s = "x".repeat(160);
  const r = callFormatResumeError(s);
  assertEqual("exactly 160 chars: unchanged (length=160)", 160, r !== null ? r.length : null);
  assertEqual("exactly 160 chars: no ellipsis", s, r);
}

// 200 chars: truncated to 159 + ellipsis (total 160)
{
  const s = "a".repeat(200);
  const r = callFormatResumeError(s);
  if (r !== null) {
    assertEqual("200 chars: length=160 (159+ellipsis)", 160, r.length);
    assertEqual("200 chars: ends with ellipsis", "\u2026", r.slice(-1));
  } else {
    fail("200 chars truncation: result should not be null");
  }
}

// custom max=2: 'abc' -> 'a…'
{
  const r = callFormatResumeError("abc", 2);
  assertEqual("custom max=2: 'abc' -> 'a\u2026'", "a\u2026", r);
}

// custom max=1: 'ab' -> '…'
{
  const r = callFormatResumeError("ab", 1);
  assertEqual("custom max=1: 'ab' -> '\u2026'", "\u2026", r);
}

// custom max=0: null
{
  const r = callFormatResumeError("something", 0);
  assertEqual("custom max=0: null", null, r);
}

// ── elapsedIssue pure helper tests ───────────────────────────────────────────
console.log("\n=== elapsedIssue pure helper ===");

function callElapsedIssueRaw(statusExpr, nowMs) {
  const nowArg = nowMs === undefined ? "" : `, ${JSON.stringify(nowMs)}`;
  const result = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module"],
    {
      input: `
import { elapsedIssue } from ${JSON.stringify(extFile)};
const status = ${statusExpr};
process.stdout.write(JSON.stringify(elapsedIssue(status${nowArg})));
`,
      encoding: "utf8",
      timeout: 10000,
    }
  );
  return JSON.parse(result);
}

const baseNow = Date.parse("2026-06-30T10:05:00Z");

{
  const r = callElapsedIssueRaw('{ current_issue_started_at: "2026-06-30T10:00:00Z", current_issue_elapsed_seconds: 61 }', baseNow);
  assertEqual("timestamp wins over frozen elapsed integer", "5m", r);
  if (r !== "1m1s") ok("timestamp result is not frozen 1m1s snapshot");
  else fail("timestamp result is not frozen 1m1s snapshot", `got ${r}`);
}

{
  const r1 = callElapsedIssueRaw('{ current_issue_started_at: "2026-06-30T10:04:00Z", current_issue_elapsed_seconds: 61 }', baseNow);
  const r2 = callElapsedIssueRaw('{ current_issue_started_at: "2026-06-30T10:04:00Z", current_issue_elapsed_seconds: 61 }', baseNow + 60_000);
  assertEqual("timestamp-derived issue age at first render", "1m", r1);
  assertEqual("timestamp-derived issue age advances on later render", "2m", r2);
}

{
  const r = callElapsedIssueRaw('{ current_issue_started_at: null, current_issue_elapsed_seconds: 61 }', baseNow);
  assertEqual("null timestamp falls back to elapsed integer", "1m1s", r);
}

{
  const r = callElapsedIssueRaw('{ current_issue_elapsed_seconds: 90 }', baseNow);
  assertEqual("absent timestamp falls back to elapsed integer", "1m30s", r);
}

{
  const r = callElapsedIssueRaw('{ current_issue_started_at: "", current_issue_elapsed_seconds: 45 }', baseNow);
  assertEqual("empty timestamp falls back to elapsed integer", "45s", r);
}

{
  const r = callElapsedIssueRaw('{ current_issue_started_at: "not-a-date", current_issue_elapsed_seconds: 30 }', baseNow);
  assertEqual("malformed timestamp falls back to elapsed integer", "30s", r);
}

{
  const r = callElapsedIssueRaw('{ current_issue_started_at: null, current_issue_elapsed_seconds: null }', baseNow);
  assertEqual("null timestamp and null integer returns unknown", "unknown", r);
}

{
  const r = callElapsedIssueRaw('undefined', baseNow);
  assertEqual("undefined status returns unknown", "unknown", r);
}

{
  const r = callElapsedIssueRaw('{ current_issue_started_at: "2026-06-30T10:15:00Z", current_issue_elapsed_seconds: 600 }', baseNow);
  assertEqual("future timestamp clamps to zero", "0s", r);
}

{
  const r = callElapsedIssueRaw('{ current_issue_started_at: null, current_issue_elapsed_seconds: 0 }', baseNow);
  assertEqual("zero elapsed integer is valid fallback", "0s", r);
}

{
  const r = callElapsedIssueRaw('{ current_issue_started_at: null, current_issue_elapsed_seconds: NaN }', baseNow);
  assertEqual("NaN elapsed integer returns unknown", "unknown", r);
}

{
  const r = callElapsedIssueRaw('{ current_issue_started_at: "2026-06-30T10:04:30Z", current_issue_elapsed_seconds: 0 }', baseNow);
  assertEqual("timestamp wins over zero elapsed integer", "30s", r);
}

// ── formatDurationActive boundary tests ─────────────────────────────────────
console.log("\n=== formatDurationActive — boundary tests ===");

function callFormatDurationActive(seconds) {
  const result = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module"],
    {
      input: `
import { formatDurationActive } from ${JSON.stringify(extFile)};
process.stdout.write(JSON.stringify(formatDurationActive(${JSON.stringify(seconds)})));
`,
      encoding: "utf8",
      timeout: 10000,
    }
  );
  return JSON.parse(result);
}

// <60s tier
assertEqual("active: 0s", "0s", callFormatDurationActive(0));
assertEqual("active: 1s", "1s", callFormatDurationActive(1));
assertEqual("active: 42s", "42s", callFormatDurationActive(42));
assertEqual("active: 59s", "59s", callFormatDurationActive(59));

// 60–599s tier (minutes + residual seconds if > 0)
assertEqual("active: 60s -> 1m", "1m", callFormatDurationActive(60));
assertEqual("active: 61s -> 1m1s", "1m1s", callFormatDurationActive(61));
assertEqual("active: 90s -> 1m30s", "1m30s", callFormatDurationActive(90));
assertEqual("active: 120s -> 2m", "2m", callFormatDurationActive(120));
assertEqual("active: 200s -> 3m20s", "3m20s", callFormatDurationActive(200));
assertEqual("active: 539s -> 8m59s", "8m59s", callFormatDurationActive(539));
assertEqual("active: 540s -> 9m (boundary of 10m tier start)", "9m", callFormatDurationActive(540));
assertEqual("active: 599s -> 9m59s", "9m59s", callFormatDurationActive(599));

// 600–3599s tier (whole minutes only)
assertEqual("active: 600s -> 10m", "10m", callFormatDurationActive(600));
assertEqual("active: 601s -> 10m (drops residual)", "10m", callFormatDurationActive(601));
assertEqual("active: 1020s -> 17m", "17m", callFormatDurationActive(1020));
assertEqual("active: 3540s -> 59m", "59m", callFormatDurationActive(3540));
assertEqual("active: 3599s -> 59m", "59m", callFormatDurationActive(3599));

// 3600–86399s tier (hours + residual minutes if > 0)
assertEqual("active: 3600s -> 1h", "1h", callFormatDurationActive(3600));
assertEqual("active: 3660s -> 1h1m", "1h1m", callFormatDurationActive(3660));
assertEqual("active: 4320s -> 1h12m", "1h12m", callFormatDurationActive(4320));
assertEqual("active: 7200s -> 2h", "2h", callFormatDurationActive(7200));
assertEqual("active: 86340s -> 23h59m", "23h59m", callFormatDurationActive(86340));
assertEqual("active: 86399s -> 23h59m", "23h59m", callFormatDurationActive(86399));

// >=86400s tier (days + residual hours if > 0)
assertEqual("active: 86400s -> 1d", "1d", callFormatDurationActive(86400));
assertEqual("active: 86401s -> 1d (sub-hour residual dropped)", "1d", callFormatDurationActive(86401));
assertEqual("active: 90000s -> 1d1h", "1d1h", callFormatDurationActive(90000));
assertEqual("active: 172800s -> 2d", "2d", callFormatDurationActive(172800));
assertEqual("active: 187200s -> 2d4h", "2d4h", callFormatDurationActive(187200));

// ── formatDurationCompleted boundary tests ────────────────────────────────────
console.log("\n=== formatDurationCompleted — boundary tests ===");

function callFormatDurationCompleted(seconds) {
  const result = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module"],
    {
      input: `
import { formatDurationCompleted } from ${JSON.stringify(extFile)};
process.stdout.write(JSON.stringify(formatDurationCompleted(${JSON.stringify(seconds)})));
`,
      encoding: "utf8",
      timeout: 10000,
    }
  );
  return JSON.parse(result);
}

// <60s tier
assertEqual("completed: 0s -> <1m", "<1m", callFormatDurationCompleted(0));
assertEqual("completed: 1s -> <1m", "<1m", callFormatDurationCompleted(1));
assertEqual("completed: 42s -> <1m", "<1m", callFormatDurationCompleted(42));
assertEqual("completed: 59s -> <1m", "<1m", callFormatDurationCompleted(59));

// 60–3599s tier (whole minutes only, no seconds residual)
assertEqual("completed: 60s -> 1m", "1m", callFormatDurationCompleted(60));
assertEqual("completed: 61s -> 1m (drops residual seconds)", "1m", callFormatDurationCompleted(61));
assertEqual("completed: 90s -> 1m", "1m", callFormatDurationCompleted(90));
assertEqual("completed: 120s -> 2m", "2m", callFormatDurationCompleted(120));
assertEqual("completed: 3360s -> 56m", "56m", callFormatDurationCompleted(3360));
assertEqual("completed: 3540s -> 59m", "59m", callFormatDurationCompleted(3540));
assertEqual("completed: 3599s -> 59m", "59m", callFormatDurationCompleted(3599));

// 3600–86399s tier (hours + residual minutes if > 0)
assertEqual("completed: 3600s -> 1h", "1h", callFormatDurationCompleted(3600));
assertEqual("completed: 3660s -> 1h1m", "1h1m", callFormatDurationCompleted(3660));
assertEqual("completed: 4320s -> 1h12m", "1h12m", callFormatDurationCompleted(4320));
assertEqual("completed: 7200s -> 2h", "2h", callFormatDurationCompleted(7200));
assertEqual("completed: 86340s -> 23h59m", "23h59m", callFormatDurationCompleted(86340));
assertEqual("completed: 86399s -> 23h59m", "23h59m", callFormatDurationCompleted(86399));

// >=86400s tier (days + residual hours if > 0)
assertEqual("completed: 86400s -> 1d", "1d", callFormatDurationCompleted(86400));
assertEqual("completed: 86401s -> 1d (sub-hour residual dropped)", "1d", callFormatDurationCompleted(86401));
assertEqual("completed: 90000s -> 1d1h", "1d1h", callFormatDurationCompleted(90000));
assertEqual("completed: 172800s -> 2d", "2d", callFormatDurationCompleted(172800));
assertEqual("completed: 187200s -> 2d4h", "2d4h", callFormatDurationCompleted(187200));

// Static checks: exports present
console.log("\n=== Static source checks — duration formatter exports ===");
assertIncludes("source: export function formatDurationActive", src, "export function formatDurationActive");
assertIncludes("source: export function formatDurationCompleted", src, "export function formatDurationCompleted");
assertNotIncludes("source: old formatDuration single-function not exported", src, "export function formatDuration(");
// elapsedSince must call formatDurationActive
{
  const esFn = src.slice(src.indexOf("function elapsedSince("), src.indexOf("\nexport function elapsedIssue"));
  assertIncludes("elapsedSince body calls formatDurationActive", esFn, "formatDurationActive(");
}
// formatCompleted must call formatDurationCompleted
{
  const fcFn = src.slice(src.indexOf("function formatCompleted("), src.indexOf("\nfunction formatIssueList"));
  assertIncludes("formatCompleted body calls formatDurationCompleted", fcFn, "formatDurationCompleted(");
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log("\n─────────────────────────────────────────────────────────────────────────────");
console.log(`Results: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) process.exit(1);
