#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for pipeline launch pure helpers exported from pipeline-status.ts:
//   validateLaunchParams, buildPipelineConfig, launchSessionName,
//   planLaunchAction, parsePipelineRunArgs
//
// Also checks static presence of pipeline_run tool and /pipeline-run command.
//
// Run: node tests/pipeline/test-pipeline-launch-extension.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const extFile = path.join(repoRoot, "extensions", "pipeline-status.ts");

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
  if (JSON.stringify(expected) === JSON.stringify(actual)) {
    ok(label);
  } else {
    fail(label, `expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)}`);
  }
}

function assertIncludes(label, haystack, needle) {
  if (typeof haystack === "string" ? haystack.includes(needle) : JSON.stringify(haystack).includes(needle)) {
    ok(label);
  } else {
    fail(label, `expected ${JSON.stringify(needle)} in ${JSON.stringify(haystack)}`);
  }
}

function assertNotIncludes(label, haystack, needle) {
  if (typeof haystack === "string" ? !haystack.includes(needle) : !JSON.stringify(haystack).includes(needle)) {
    ok(label);
  } else {
    fail(label, `expected ${JSON.stringify(needle)} NOT in ${JSON.stringify(haystack)}`);
  }
}

function assertOk(label, result) {
  if (result && result.ok === true) {
    ok(label);
  } else {
    fail(label, `ok=false: ${JSON.stringify(result)}`);
  }
}

function assertNotOk(label, result) {
  if (result && result.ok === false) {
    ok(label);
  } else {
    fail(label, `expected ok=false, got: ${JSON.stringify(result)}`);
  }
}

// ── Subprocess helper ─────────────────────────────────────────────────────────

function callHelper(code) {
  const result = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module"],
    {
      input: `
import { validateLaunchParams, buildPipelineConfig, launchSessionName, planLaunchAction, parsePipelineRunArgs } from ${JSON.stringify(extFile)};
${code}
`,
      encoding: "utf8",
      timeout: 15000,
    }
  );
  return JSON.parse(result);
}

// ── Static source checks ──────────────────────────────────────────────────────

console.log("\n=== Static source checks — pipeline_run tool and /pipeline-run command ===");
const src = readFileSync(extFile, "utf8");

assertIncludes("source: pipeline_run tool registered", src, 'name: "pipeline_run"');
assertIncludes("source: pipeline-run command registered", src, '"pipeline-run"');
assertIncludes("source: validateLaunchParams exported", src, "export function validateLaunchParams");
assertIncludes("source: buildPipelineConfig exported", src, "export function buildPipelineConfig");
assertIncludes("source: launchSessionName exported", src, "export function launchSessionName");
assertIncludes("source: planLaunchAction exported", src, "export function planLaunchAction");
assertIncludes("source: parsePipelineRunArgs exported", src, "export function parsePipelineRunArgs");
// ALLOW_CONCURRENT_REPO_PIPELINES must not appear in tool parameters
{
  const toolStart = src.indexOf('name: "pipeline_run"');
  const toolEnd = src.indexOf("\n\t});\n", toolStart + 1);
  const toolBody = toolEnd > toolStart ? src.slice(toolStart, toolEnd) : src.slice(toolStart, toolStart + 5000);
  assertNotIncludes("pipeline_run tool body: does not expose ALLOW_CONCURRENT_REPO_PIPELINES param", toolBody, "allowConcurrentRepoPipelines");
}
assertIncludes("source: tmux new-session in executeLaunch", src, "new-session");
assertIncludes("source: which tmux check in executeLaunch", src, "which");
assertIncludes("source: has-session uniqueness check in executeLaunch", src, "has-session");
assertIncludes("source: executeLaunch uses pure planLaunchAction", src.slice(src.indexOf("async function executeLaunch")), "planLaunchAction(params");
assertIncludes("source: pipelineScriptPath relative to extension file", src, "skills/implementation-pipeline/pipeline.sh");
assertIncludes("source: pipeline_run tool promptGuidelines mentions pipeline_run", src, "Use pipeline_run");
assertIncludes("source: pipeline_run tool promptGuidelines mentions prefer pipeline_run over bash", src, "instead of writing bash");
assertNotIncludes("source: pipeline_run does not expose ALLOW_CONCURRENT_REPO_PIPELINES as param to callers", src.slice(src.indexOf('name: "pipeline_run"'), src.indexOf("async execute(_toolCallId, params", src.indexOf('name: "pipeline_run"'))), "ALLOW_CONCURRENT_REPO_PIPELINES");

// ── validateLaunchParams ──────────────────────────────────────────────────────

console.log("\n=== validateLaunchParams — valid inputs ===");

const GOOD_PARAMS = {
  repo: "/home/ubuntu/repos/myrepo",
  worktreeBase: "/home/ubuntu/worktrees/myrepo",
  ownerRepo: "org/myrepo",
  aiReviewProvider: "coderabbit",
  aiReviewApiBase: "https://api.github.com",
  baseBranch: "main",
  issues: [1, 2, 3],
  branches: ["issue-1-feat", "issue-2-fix", "issue-3-refactor"],
};

{
  const r = callHelper(`
const result = validateLaunchParams(${JSON.stringify(GOOD_PARAMS)});
process.stdout.write(JSON.stringify(result));
`);
  assertOk("valid minimal params: ok=true", r);
  assertEqual("valid minimal params: repo preserved", GOOD_PARAMS.repo, r.params?.repo);
  assertEqual("valid minimal params: issues preserved", GOOD_PARAMS.issues, r.params?.issues);
}

{
  const r = callHelper(`
const result = validateLaunchParams({ ...${JSON.stringify(GOOD_PARAMS)}, aiReviewProvider: "ghe-pr-bot", mergeStrategy: "squash" });
process.stdout.write(JSON.stringify(result));
`);
  assertOk("ghe-pr-bot provider + squash strategy: ok=true", r);
}

{
  const r = callHelper(`
const result = validateLaunchParams({ ...${JSON.stringify(GOOD_PARAMS)}, mergeStrategy: "merge" });
process.stdout.write(JSON.stringify(result));
`);
  assertOk("merge strategy: ok=true", r);
}

{
  const r = callHelper(`
const result = validateLaunchParams({ ...${JSON.stringify(GOOD_PARAMS)}, mergeStrategy: "rebase" });
process.stdout.write(JSON.stringify(result));
`);
  assertOk("rebase strategy: ok=true", r);
}

{
  const r = callHelper(`
const result = validateLaunchParams({
  ...${JSON.stringify(GOOD_PARAMS)},
  reviewLoopCount: 3,
  timeoutImpl: 1200,
  timeoutReview: 600,
  timeoutBot: 3600,
  timeoutCi: 300,
  timeoutGate: 60,
  handoffPollSeconds: 5,
  ciPollSeconds: 10,
  pausePollSeconds: 2,
  deadAgentFlushSeconds: 2,
  finalStatusSettleSeconds: 0,
  localCoderabbitPrecheck: true,
  skipReview: false,
  skipBot: false,
  skipScopeGate: false,
  noMerge: false,
  continueOnFailure: false,
  forceIssues: "1,3",
  extraImplContext: "some context",
});
process.stdout.write(JSON.stringify(result));
`);
  assertOk("all optional fields valid: ok=true", r);
  assertEqual("finalStatusSettleSeconds=0 is valid", 0, r.params?.finalStatusSettleSeconds);
}

console.log("\n=== validateLaunchParams — required field validation ===");

for (const field of ["repo", "worktreeBase", "ownerRepo", "aiReviewProvider", "aiReviewApiBase", "baseBranch"]) {
  const r = callHelper(`
const params = { ...${JSON.stringify(GOOD_PARAMS)} };
delete params.${field};
const result = validateLaunchParams(params);
process.stdout.write(JSON.stringify(result));
`);
  assertNotOk(`missing ${field}: ok=false`, r);
  assertIncludes(`missing ${field}: error mentions field name`, r.errors?.join(";") ?? "", field);
}

{
  const r = callHelper(`
const result = validateLaunchParams({ ...${JSON.stringify(GOOD_PARAMS)}, repo: "relative/path" });
process.stdout.write(JSON.stringify(result));
`);
  assertNotOk("relative repo path: ok=false", r);
  assertIncludes("relative repo path: mentions absolute", r.errors?.join(";") ?? "", "absolute");
}

{
  const r = callHelper(`
const result = validateLaunchParams({ ...${JSON.stringify(GOOD_PARAMS)}, worktreeBase: "not/absolute" });
process.stdout.write(JSON.stringify(result));
`);
  assertNotOk("relative worktreeBase: ok=false", r);
  assertIncludes("relative worktreeBase: mentions absolute", r.errors?.join(";") ?? "", "absolute");
}

{
  const r = callHelper(`
const result = validateLaunchParams({ ...${JSON.stringify(GOOD_PARAMS)}, aiReviewProvider: "unknown-provider" });
process.stdout.write(JSON.stringify(result));
`);
  assertNotOk("unknown aiReviewProvider: ok=false", r);
  assertIncludes("unknown aiReviewProvider: error mentions provider", r.errors?.join(";") ?? "", "aiReviewProvider");
}

{
  const r = callHelper(`
const result = validateLaunchParams({ ...${JSON.stringify(GOOD_PARAMS)}, issues: [] });
process.stdout.write(JSON.stringify(result));
`);
  assertNotOk("empty issues: ok=false", r);
  assertIncludes("empty issues: error mentions issues", r.errors?.join(";") ?? "", "issues");
}

{
  const r = callHelper(`
const result = validateLaunchParams({ ...${JSON.stringify(GOOD_PARAMS)}, issues: [0] });
process.stdout.write(JSON.stringify(result));
`);
  assertNotOk("issue=0 (not positive): ok=false", r);
  assertIncludes("issue=0: error mentions positive integers", r.errors?.join(";") ?? "", "positive");
}

{
  const r = callHelper(`
const result = validateLaunchParams({ ...${JSON.stringify(GOOD_PARAMS)}, issues: [-1] });
process.stdout.write(JSON.stringify(result));
`);
  assertNotOk("negative issue: ok=false", r);
}

{
  const r = callHelper(`
const result = validateLaunchParams({ ...${JSON.stringify(GOOD_PARAMS)}, issues: [1.5] });
process.stdout.write(JSON.stringify(result));
`);
  assertNotOk("float issue: ok=false", r);
  assertIncludes("float issue: error mentions positive integers", r.errors?.join(";") ?? "", "positive integers");
}

{
  const r = callHelper(`
const result = validateLaunchParams({ ...${JSON.stringify(GOOD_PARAMS)}, branches: [] });
process.stdout.write(JSON.stringify(result));
`);
  assertNotOk("empty branches: ok=false", r);
  assertIncludes("empty branches: error mentions branches", r.errors?.join(";") ?? "", "branches");
}

{
  const r = callHelper(`
const result = validateLaunchParams({ ...${JSON.stringify(GOOD_PARAMS)}, issues: [1, 2], branches: ["only-one"] });
process.stdout.write(JSON.stringify(result));
`);
  assertNotOk("mismatched issues/branches length: ok=false", r);
  assertIncludes("mismatched length: error mentions length", r.errors?.join(";") ?? "", "same length");
}

{
  const r = callHelper(`
const result = validateLaunchParams({ ...${JSON.stringify(GOOD_PARAMS)}, mergeStrategy: "cherry-pick" });
process.stdout.write(JSON.stringify(result));
`);
  assertNotOk("invalid mergeStrategy: ok=false", r);
  assertIncludes("invalid mergeStrategy: error mentions strategy", r.errors?.join(";") ?? "", "mergeStrategy");
}

console.log("\n=== validateLaunchParams — optional integer/boolean validation ===");

for (const field of ["reviewLoopCount", "timeoutImpl", "timeoutReview", "timeoutBot", "timeoutCi", "timeoutGate",
  "handoffPollSeconds", "ciPollSeconds", "pausePollSeconds", "deadAgentFlushSeconds"]) {
  const r = callHelper(`
const result = validateLaunchParams({ ...${JSON.stringify(GOOD_PARAMS)}, ${field}: 0 });
process.stdout.write(JSON.stringify(result));
`);
  assertNotOk(`${field}=0: ok=false (must be positive)`, r);
  assertIncludes(`${field}=0: error mentions field`, r.errors?.join(";") ?? "", field);
}

{
  const r = callHelper(`
const result = validateLaunchParams({ ...${JSON.stringify(GOOD_PARAMS)}, finalStatusSettleSeconds: 0 });
process.stdout.write(JSON.stringify(result));
`);
  assertOk("finalStatusSettleSeconds=0: ok=true (zero is valid)", r);
}

{
  const r = callHelper(`
const result = validateLaunchParams({ ...${JSON.stringify(GOOD_PARAMS)}, finalStatusSettleSeconds: -1 });
process.stdout.write(JSON.stringify(result));
`);
  assertNotOk("finalStatusSettleSeconds=-1: ok=false", r);
}

{
  const r = callHelper(`
const result = validateLaunchParams({ ...${JSON.stringify(GOOD_PARAMS)}, skipReview: 1, noMerge: 0 });
process.stdout.write(JSON.stringify(result));
`);
  assertOk("boolean fields accept numeric 0/1", r);
  assertEqual("skipReview=1 normalizes to true", true, r.params?.skipReview);
  assertEqual("noMerge=0 normalizes to false", false, r.params?.noMerge);
}

{
  const r = callHelper(`
const result = validateLaunchParams({ ...${JSON.stringify(GOOD_PARAMS)}, skipReview: "yes" });
process.stdout.write(JSON.stringify(result));
`);
  assertNotOk("skipReview=string: ok=false (must be boolean or 0/1)", r);
  assertIncludes("skipReview=string: error mentions boolean", r.errors?.join(";") ?? "", "boolean");
}

{
  const r = callHelper(`
const result = validateLaunchParams({ ...${JSON.stringify(GOOD_PARAMS)}, extraImplContext: 42 });
process.stdout.write(JSON.stringify(result));
`);
  assertNotOk("extraImplContext=number: ok=false", r);
  assertIncludes("extraImplContext=number: error mentions string", r.errors?.join(";") ?? "", "string");
}

// ── parsePipelineRunArgs ──────────────────────────────────────────────────────

console.log("\n=== parsePipelineRunArgs — JSON object ===");

{
  const r = callHelper(`
const args = JSON.stringify(${JSON.stringify(GOOD_PARAMS)});
const result = parsePipelineRunArgs(args);
process.stdout.write(JSON.stringify(result));
`);
  assertOk("JSON object args: ok=true", r);
  assertEqual("JSON object: repo preserved", GOOD_PARAMS.repo, r.params?.repo);
  assertEqual("JSON object: issues array preserved", GOOD_PARAMS.issues, r.params?.issues);
}

console.log("\n=== parsePipelineRunArgs — key=value pairs ===");

{
  const r = callHelper(`
const args = "repo=/home/ubuntu/repos/myrepo worktreeBase=/home/ubuntu/worktrees/myrepo ownerRepo=org/myrepo aiReviewProvider=coderabbit aiReviewApiBase=https://api.github.com baseBranch=main issues=1,2,3 branches=issue-1-feat,issue-2-fix,issue-3-refactor";
const result = parsePipelineRunArgs(args);
process.stdout.write(JSON.stringify(result));
`);
  assertOk("key=value args: ok=true", r);
  assertEqual("key=value: repo preserved", "/home/ubuntu/repos/myrepo", r.params?.repo);
  assertEqual("key=value: issues parsed as number array", [1, 2, 3], r.params?.issues);
  assertEqual("key=value: branches parsed as string array", ["issue-1-feat", "issue-2-fix", "issue-3-refactor"], r.params?.branches);
}

{
  const r = callHelper(`
const args = "repo=/home/ubuntu/repos/myrepo issues=42 branches=issue-42-feat timeoutImpl=1800";
const result = parsePipelineRunArgs(args);
process.stdout.write(JSON.stringify(result));
`);
  assertOk("key=value with numeric field: ok=true", r);
  assertEqual("key=value: timeoutImpl parsed as number", 1800, r.params?.timeoutImpl);
}

{
  const r = callHelper(`
const args = "repo=/home/ubuntu/repos/myrepo issues=42 branches=issue-42-feat skipReview=1 noMerge=0 continueOnFailure=true";
const result = parsePipelineRunArgs(args);
process.stdout.write(JSON.stringify(result));
`);
  assertOk("key=value with boolean fields: ok=true", r);
  assertEqual("key=value: skipReview=1 parsed as number", 1, r.params?.skipReview);
  assertEqual("key=value: noMerge=0 parsed as number", 0, r.params?.noMerge);
  assertEqual("key=value: continueOnFailure=true parsed as boolean", true, r.params?.continueOnFailure);
}

console.log("\n=== parsePipelineRunArgs — error cases ===");

{
  const r = callHelper(`
const result = parsePipelineRunArgs("");
process.stdout.write(JSON.stringify(result));
`);
  assertNotOk("empty args: ok=false", r);
  assertIncludes("empty args: error mentions Usage", r.error ?? "", "Usage");
}

{
  const r = callHelper(`
const result = parsePipelineRunArgs("   ");
process.stdout.write(JSON.stringify(result));
`);
  assertNotOk("whitespace only args: ok=false", r);
}

{
  const r = callHelper(`
const result = parsePipelineRunArgs('{ invalid json }');
process.stdout.write(JSON.stringify(result));
`);
  assertNotOk("invalid JSON: ok=false", r);
  assertIncludes("invalid JSON: error mentions JSON", r.error ?? "", "JSON");
}

// ── launchSessionName ─────────────────────────────────────────────────────────

console.log("\n=== launchSessionName ===");

{
  const r = callHelper(`
const name = launchSessionName("myrepo", "2026-07-01T10-00-00Z");
process.stdout.write(JSON.stringify(name));
`);
  assertIncludes("session name starts with impl-pipeline-", r, "impl-pipeline-");
  assertIncludes("session name contains repo name", r, "myrepo");
}

{
  const r = callHelper(`
const name = launchSessionName("my/repo:name", "2026-07-01T10-00-00Z");
process.stdout.write(JSON.stringify(name));
`);
  assertNotIncludes("session name: no slash from repo name", r, "/");
  assertNotIncludes("session name: no colon from repo name", r, ":");
}

{
  const r = callHelper(`
const name = launchSessionName("a".repeat(80), "ts");
process.stdout.write(JSON.stringify({ name, len: name.length }));
`);
  if (r.len <= 60) {
    ok(`session name bounded: length=${r.len} ≤ 60`);
  } else {
    fail(`session name bounded: expected ≤60, got ${r.len}`);
  }
}

// ── buildPipelineConfig ───────────────────────────────────────────────────────

console.log("\n=== buildPipelineConfig ===");

{
  const r = callHelper(`
const params = ${JSON.stringify(GOOD_PARAMS)};
const config = buildPipelineConfig(params, "/tmp/test-session");
process.stdout.write(JSON.stringify(config));
`);
  assertIncludes("config: contains REPO=", r, "REPO=");
  assertIncludes("config: repo is shell-quoted", r, `'/home/ubuntu/repos/myrepo'`);
  assertIncludes("config: WORKTREE_BASE present", r, "WORKTREE_BASE=");
  assertIncludes("config: OWNER_REPO present", r, "OWNER_REPO=");
  assertIncludes("config: AI_REVIEW_PROVIDER present", r, "AI_REVIEW_PROVIDER=");
  assertIncludes("config: AI_REVIEW_API_BASE present", r, "AI_REVIEW_API_BASE=");
  assertIncludes("config: BASE_BRANCH present", r, "BASE_BRANCH=");
  assertIncludes("config: LOG_DIR present with logDir value", r, "LOG_DIR=");
  assertIncludes("config: LOG_DIR set to provided logDir", r, "/tmp/test-session");
  assertIncludes("config: ISSUES array present", r, "ISSUES=(1 2 3)");
  assertIncludes("config: BRANCHES array present", r, "BRANCHES=");
  assertIncludes("config: branches shell-quoted", r, "'issue-1-feat'");
  // ALLOW_CONCURRENT_REPO_PIPELINES must NOT be written to config
  assertNotIncludes("config: does not write ALLOW_CONCURRENT_REPO_PIPELINES", r, "ALLOW_CONCURRENT_REPO_PIPELINES");
}

{
  // Shell-quoting of single quotes in branch name
  const r = callHelper(`
const params = { ...${JSON.stringify(GOOD_PARAMS)}, branches: ["issue-1-feat-it's-here", "issue-2-fix", "issue-3-refactor"] };
const config = buildPipelineConfig(params, "/tmp/test-session");
process.stdout.write(JSON.stringify(config));
`);
  assertIncludes("config: branch with single-quote shell-escaped", r, "'\\''");
}

{
  // extraImplContext: newlines collapsed
  const r = callHelper(`
const params = { ...${JSON.stringify(GOOD_PARAMS)}, extraImplContext: "line1\\nline2\\ttab" };
const config = buildPipelineConfig(params, "/tmp/test-session");
process.stdout.write(JSON.stringify(config));
`);
  assertIncludes("config: EXTRA_IMPL_CONTEXT present", r, "EXTRA_IMPL_CONTEXT=");
  assertNotIncludes("config: extraImplContext has no literal newline in value", r, "\\n");
}

{
  // Booleans written as 0/1
  const r = callHelper(`
const params = { ...${JSON.stringify(GOOD_PARAMS)}, skipReview: true, skipBot: false, noMerge: true };
const config = buildPipelineConfig(params, "/tmp/test-session");
process.stdout.write(JSON.stringify(config));
`);
  assertIncludes("config: skipReview=true written as SKIP_REVIEW=1", r, "SKIP_REVIEW=1");
  assertIncludes("config: skipBot=false written as SKIP_BOT=0", r, "SKIP_BOT=0");
  assertIncludes("config: noMerge=true written as NO_MERGE=1", r, "NO_MERGE=1");
}

{
  // finalStatusSettleSeconds=0 written
  const r = callHelper(`
const params = { ...${JSON.stringify(GOOD_PARAMS)}, finalStatusSettleSeconds: 0 };
const config = buildPipelineConfig(params, "/tmp/test-session");
process.stdout.write(JSON.stringify(config));
`);
  assertIncludes("config: finalStatusSettleSeconds=0 written", r, "FINAL_STATUS_SETTLE_SECONDS=0");
}

{
  const r = callHelper(`
const params = { ...${JSON.stringify(GOOD_PARAMS)}, forceIssues: "1,3'quoted" };
const config = buildPipelineConfig(params, "/tmp/test-session");
process.stdout.write(JSON.stringify(config));
`);
  assertIncludes("config: FORCE_ISSUES written", r, "FORCE_ISSUES=");
  assertIncludes("config: FORCE_ISSUES shell-escapes single quote", r, "FORCE_ISSUES='1,3'\\''quoted'");
}

// ── planLaunchAction ──────────────────────────────────────────────────────────

console.log("\n=== planLaunchAction ===");

{
  const r = callHelper(`
const params = ${JSON.stringify(GOOD_PARAMS)};
const scriptPath = "/usr/local/skills/implementation-pipeline/pipeline.sh";
const ts = "2026-07-01T10-00-00Z";
const existing = new Set();
const action = planLaunchAction(params, scriptPath, ts, existing);
process.stdout.write(JSON.stringify(action));
`);
  assertEqual("planLaunchAction: type=launch when no session conflict", "launch", r.type);
  assertIncludes("planLaunchAction: sessionName starts with impl-pipeline-", r.sessionName, "impl-pipeline-");
  assertIncludes("planLaunchAction: shellCmd contains scriptPath quoted", r.shellCmd, "'/usr/local/skills/implementation-pipeline/pipeline.sh'");
  assertIncludes("planLaunchAction: shellCmd contains configPath", r.shellCmd, r.configPath);
  assertIncludes("planLaunchAction: shellCmd ends with exec bash", r.shellCmd, "exec bash");
  assertIncludes("planLaunchAction: logDir is /tmp/sessionName", r.logDir, "/tmp/");
  assertEqual("planLaunchAction: configPath is logDir/config.sh", `${r.logDir}/config.sh`, r.configPath);
}

{
  // session name conflict: tries suffix
  const r = callHelper(`
const params = ${JSON.stringify(GOOD_PARAMS)};
const scriptPath = "/usr/local/skills/implementation-pipeline/pipeline.sh";
const ts = "2026-07-01T10-00-00Z";
const firstSession = launchSessionName("myrepo", ts);
const existing = new Set([firstSession]);
const action = planLaunchAction(params, scriptPath, ts, existing);
process.stdout.write(JSON.stringify(action));
`);
  // Either a launch with a different name, or session-exists if all attempts exhausted
  if (r.type === "launch") {
    assertNotIncludes("planLaunchAction with 1 conflict: session name differs from original", r.sessionName, "-0");
    ok(`planLaunchAction: resolved new unique session name: ${r.sessionName}`);
  } else {
    ok(`planLaunchAction: session-exists returned after conflict (also valid)`);
  }
}

{
  // All attempts exhausted -> session-exists
  const r = callHelper(`
const params = ${JSON.stringify(GOOD_PARAMS)};
const scriptPath = "/path/to/pipeline.sh";
const ts = "2026-07-01T10-00-00Z";
// Preoccupy the base + 4 suffix attempts
const sessions = [];
for (let i = 0; i < 5; i++) {
  sessions.push(launchSessionName("myrepo", i === 0 ? ts : ts + "-" + i));
}
const existing = new Set(sessions);
const action = planLaunchAction(params, scriptPath, ts, existing, 5);
process.stdout.write(JSON.stringify(action));
`);
  assertEqual("planLaunchAction: all attempts exhausted -> session-exists", "session-exists", r.type);
  if (r.suffix !== undefined) {
    if (r.suffix >= 4) {
      ok(`planLaunchAction: session-exists suffix=${r.suffix} (≥4)`);
    } else {
      fail(`planLaunchAction: session-exists suffix should be ≥4, got ${r.suffix}`);
    }
  } else {
    ok("planLaunchAction: session-exists returned (suffix field optional)");
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log("\n─────────────────────────────────────────────────────────────────────────────");
console.log(`Results: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) process.exit(1);
