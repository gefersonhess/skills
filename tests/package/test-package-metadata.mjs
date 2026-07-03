#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Package metadata coherence test — Phase 5D
//
// Validates that package.json, README.md, and CHANGELOG.md are mutually
// consistent: version format, pi arrays, path presence, install line, and
// changelog header.
//
// Includes inline pure-helper fixture tests (unhappy paths) so the harness
// catches regressions without mutating any files.
//
// Run: node tests/package/test-package-metadata.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

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

function assertMatch(label, value, re) {
  if (re.test(value)) {
    ok(label);
  } else {
    fail(label, `${JSON.stringify(value)} did not match ${re}`);
  }
}

function assertIncludes(label, haystack, needle) {
  if (haystack.includes(needle)) {
    ok(label);
  } else {
    fail(label, `expected ${JSON.stringify(needle)} in value`);
  }
}

// ── Pure metadata checker ─────────────────────────────────────────────────────
//
// checkMetadata({ pkg, readme, changelog, root }) → { errors: string[] }
//
// Accepts plain objects/strings so it can be exercised with synthetic fixtures
// without touching the filesystem (except for path-existence checks, which
// require a real root to be passed).

function checkMetadata({ pkg, readme, changelog, root }) {
  const errors = [];

  // 1. pkg must be a plain object (parse already done by caller)
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
    errors.push("package.json: not a plain object");
    return { errors };
  }

  // 2. version: must be a string matching semver-ish
  const SEMVER_ISH = /^\d+\.\d+\.\d+/;
  if (typeof pkg.version !== "string" || !SEMVER_ISH.test(pkg.version)) {
    errors.push(
      `package.json: version must be a string matching /^\\d+\\.\\d+\\.\\d+/, got ${JSON.stringify(pkg.version)}`
    );
  }

  const version = typeof pkg.version === "string" ? pkg.version : null;

  // 3. pi.skills: non-empty array of strings
  const pi = pkg.pi;
  if (!pi || typeof pi !== "object" || Array.isArray(pi)) {
    errors.push("package.json: pi must be a plain object");
  } else {
    if (!Array.isArray(pi.skills) || pi.skills.length === 0) {
      errors.push("package.json: pi.skills must be a non-empty array of strings");
    } else {
      for (const entry of pi.skills) {
        if (typeof entry !== "string") {
          errors.push(`package.json: pi.skills entry is not a string: ${JSON.stringify(entry)}`);
        }
      }
    }

    // 4. pi.extensions: non-empty array of strings
    if (!Array.isArray(pi.extensions) || pi.extensions.length === 0) {
      errors.push("package.json: pi.extensions must be a non-empty array of strings");
    } else {
      for (const entry of pi.extensions) {
        if (typeof entry !== "string") {
          errors.push(`package.json: pi.extensions entry is not a string: ${JSON.stringify(entry)}`);
        }
      }
    }

    // 5. each pi.skills and pi.extensions entry must resolve to an existing directory
    if (root) {
      const allPaths = [
        ...(Array.isArray(pi.skills) ? pi.skills : []),
        ...(Array.isArray(pi.extensions) ? pi.extensions : []),
      ];
      for (const entry of allPaths) {
        if (typeof entry !== "string") continue;
        const resolved = path.resolve(root, entry);
        let isDir = false;
        try {
          isDir = statSync(resolved).isDirectory();
        } catch {
          isDir = false;
        }
        if (!isDir) {
          errors.push(`package.json: pi path does not resolve to an existing directory: ${JSON.stringify(entry)} → ${resolved}`);
        }
      }
    }
  }

  // 6. README install line: must contain pi install git:...@v<version>
  if (version !== null) {
    const installPattern = `@v${version}`;
    // Match a line containing "pi install git:" and the versioned tag
    const hasInstall =
      typeof readme === "string" &&
      readme.split("\n").some(
        (line) => line.includes("pi install git:") && line.includes(installPattern)
      );
    if (!hasInstall) {
      errors.push(
        `README.md: no canonical install line matching \`pi install git:...@v${version}\``
      );
    }
  }

  // 7. CHANGELOG must contain a header line with ## [<version>]
  if (version !== null) {
    const changelogHeader = `## [${version}]`;
    const hasHeader =
      typeof changelog === "string" &&
      changelog.split("\n").some((line) => line.includes(changelogHeader));
    if (!hasHeader) {
      errors.push(
        `CHANGELOG.md: no header line containing \`## [${version}]\``
      );
    }
  }

  return { errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION A: Inline pure-helper fixture tests (unhappy paths)
// These tests run checkMetadata() with synthetic data — no filesystem reads.
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n=== Fixture tests — unhappy paths ===");

// Helper: assert that checkMetadata returns at least one error matching needle
function assertCheckFails(label, fixture, needle) {
  const { errors } = checkMetadata(fixture);
  if (errors.length === 0) {
    fail(label, "expected at least one error, got none");
    return;
  }
  if (needle && !errors.some((e) => e.includes(needle))) {
    fail(label, `expected error containing ${JSON.stringify(needle)}, got: ${JSON.stringify(errors)}`);
    return;
  }
  ok(label);
}

// Helper: assert that checkMetadata returns no errors
function assertCheckPasses(label, fixture) {
  const { errors } = checkMetadata(fixture);
  if (errors.length === 0) {
    ok(label);
  } else {
    fail(label, `expected no errors, got: ${JSON.stringify(errors)}`);
  }
}

const GOOD_README = "```bash\npi install git:git@github.com:user/repo.git@v1.2.3\n```";
const GOOD_CHANGELOG = "## [1.2.3] - Unreleased\n\nSome changes.";
const GOOD_PKG = {
  name: "test",
  version: "1.2.3",
  pi: { skills: ["./skills"], extensions: ["./extensions"] },
};

// A1. Missing package version fails
assertCheckFails(
  "missing package version fails",
  { pkg: { name: "test", pi: { skills: ["./skills"], extensions: ["./extensions"] } }, readme: GOOD_README, changelog: GOOD_CHANGELOG, root: null },
  "version must be a string"
);

// A2. Invalid version "next" fails
assertCheckFails(
  'invalid version "next" fails',
  { pkg: { ...GOOD_PKG, version: "next" }, readme: GOOD_README, changelog: GOOD_CHANGELOG, root: null },
  "version must be a string"
);

// A3. Invalid version "0.2.0-beta" — should PASS (has digit prefix)
assertCheckPasses(
  "pre-release version 0.2.0-beta passes semver-ish check",
  { pkg: { ...GOOD_PKG, version: "0.2.0-beta" }, readme: "pi install git:git@github.com:user/repo.git@v0.2.0-beta", changelog: "## [0.2.0-beta]\n", root: null }
);

// A4. Missing pi.skills fails
assertCheckFails(
  "missing pi.skills fails",
  { pkg: { ...GOOD_PKG, pi: { extensions: ["./extensions"] } }, readme: GOOD_README, changelog: GOOD_CHANGELOG, root: null },
  "pi.skills must be a non-empty array"
);

// A5. Non-array pi.skills fails
assertCheckFails(
  "non-array pi.skills fails",
  { pkg: { ...GOOD_PKG, pi: { skills: "./skills", extensions: ["./extensions"] } }, readme: GOOD_README, changelog: GOOD_CHANGELOG, root: null },
  "pi.skills must be a non-empty array"
);

// A6. Empty pi.skills array fails
assertCheckFails(
  "empty pi.skills array fails",
  { pkg: { ...GOOD_PKG, pi: { skills: [], extensions: ["./extensions"] } }, readme: GOOD_README, changelog: GOOD_CHANGELOG, root: null },
  "pi.skills must be a non-empty array"
);

// A7. Missing pi.extensions fails
assertCheckFails(
  "missing pi.extensions fails",
  { pkg: { ...GOOD_PKG, pi: { skills: ["./skills"] } }, readme: GOOD_README, changelog: GOOD_CHANGELOG, root: null },
  "pi.extensions must be a non-empty array"
);

// A8. Empty pi.extensions array fails
assertCheckFails(
  "empty pi.extensions array fails",
  { pkg: { ...GOOD_PKG, pi: { skills: ["./skills"], extensions: [] } }, readme: GOOD_README, changelog: GOOD_CHANGELOG, root: null },
  "pi.extensions must be a non-empty array"
);

// A9. Bad README install version fails
assertCheckFails(
  "wrong README install version fails",
  { pkg: GOOD_PKG, readme: "pi install git:git@github.com:user/repo.git@v9.9.9", changelog: GOOD_CHANGELOG, root: null },
  "no canonical install line"
);

// A10. README with no install line at all fails
assertCheckFails(
  "README with no install line fails",
  { pkg: GOOD_PKG, readme: "# Just a readme", changelog: GOOD_CHANGELOG, root: null },
  "no canonical install line"
);

// A11. Missing changelog header fails
assertCheckFails(
  "missing changelog version header fails",
  { pkg: GOOD_PKG, readme: GOOD_README, changelog: "## [0.1.0] - Old\n", root: null },
  "no header line containing"
);

// A12. Changelog with only Unreleased (no version number) fails
assertCheckFails(
  "changelog with only Unreleased header (no version) fails",
  { pkg: GOOD_PKG, readme: GOOD_README, changelog: "## Unreleased\n\n- work in progress\n", root: null },
  "no header line containing"
);

// A13. CHANGELOG with matching version in suffix ("[1.2.3] - Unreleased") passes
assertCheckPasses(
  "changelog header with Unreleased suffix passes",
  { pkg: GOOD_PKG, readme: GOOD_README, changelog: "## [1.2.3] - Unreleased\n", root: null }
);

// A14. CHANGELOG with matching version and date suffix passes
assertCheckPasses(
  "changelog header with date suffix passes",
  { pkg: GOOD_PKG, readme: GOOD_README, changelog: "## [1.2.3] - 2026-06-30\n", root: null }
);

// A15. pi object is an array fails
assertCheckFails(
  "pi as array fails",
  { pkg: { ...GOOD_PKG, pi: ["./skills"] }, readme: GOOD_README, changelog: GOOD_CHANGELOG, root: null },
  "pi must be a plain object"
);

// A16. Good fixture with no root passes (no path checks)
assertCheckPasses(
  "fully valid fixture without root passes",
  { pkg: GOOD_PKG, readme: GOOD_README, changelog: GOOD_CHANGELOG, root: null }
);

// A17. Non-string entry in pi.skills array fails
assertCheckFails(
  "non-string entry in pi.skills fails",
  { pkg: { ...GOOD_PKG, pi: { skills: [42], extensions: ["./extensions"] } }, readme: GOOD_README, changelog: GOOD_CHANGELOG, root: null },
  "pi.skills entry is not a string"
);

// A18. Non-string entry in pi.extensions array fails
assertCheckFails(
  "non-string entry in pi.extensions fails",
  { pkg: { ...GOOD_PKG, pi: { skills: ["./skills"], extensions: [null] } }, readme: GOOD_README, changelog: GOOD_CHANGELOG, root: null },
  "pi.extensions entry is not a string"
);

// ─────────────────────────────────────────────────────────────────────────────
// SECTION B: Live metadata validation against actual repo files
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n=== Live metadata validation ===");

// B1. package.json parses
let pkg;
try {
  const raw = readFileSync(path.join(repoRoot, "package.json"), "utf8");
  pkg = JSON.parse(raw);
  ok("package.json: parses as JSON");
} catch (e) {
  fail("package.json: parses as JSON", e.message);
  console.error("FATAL: cannot continue without a parseable package.json");
  process.exit(1);
}

// B2–B7. Run checkMetadata with real files
let readme, changelog;
try {
  readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
  ok("README.md: readable");
} catch (e) {
  fail("README.md: readable", e.message);
  readme = "";
}

try {
  changelog = readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  ok("CHANGELOG.md: readable");
} catch (e) {
  fail("CHANGELOG.md: readable", e.message);
  changelog = "";
}

const { errors: liveErrors } = checkMetadata({ pkg, readme, changelog, root: repoRoot });
if (liveErrors.length === 0) {
  ok("live metadata: pure checker reports no errors");
} else {
  fail("live metadata: pure checker reports no errors", JSON.stringify(liveErrors));
}

// Report each live check individually
const version = typeof pkg.version === "string" ? pkg.version : null;
const SEMVER_ISH = /^\d+\.\d+\.\d+/;

if (typeof pkg.version === "string" && SEMVER_ISH.test(pkg.version)) {
  ok(`package.json: version is semver-ish string (${pkg.version})`);
} else {
  fail("package.json: version is semver-ish string", `got ${JSON.stringify(pkg.version)}`);
}

const pi = pkg.pi;
if (pi && !Array.isArray(pi) && typeof pi === "object") {
  ok("package.json: pi is a plain object");

  if (Array.isArray(pi.skills) && pi.skills.length > 0 && pi.skills.every((e) => typeof e === "string")) {
    ok(`package.json: pi.skills is a non-empty string array (${pi.skills.length} entries)`);
  } else {
    fail("package.json: pi.skills is a non-empty string array", JSON.stringify(pi.skills));
  }

  if (Array.isArray(pi.extensions) && pi.extensions.length > 0 && pi.extensions.every((e) => typeof e === "string")) {
    ok(`package.json: pi.extensions is a non-empty string array (${pi.extensions.length} entries)`);
  } else {
    fail("package.json: pi.extensions is a non-empty string array", JSON.stringify(pi.extensions));
  }

  // Path existence checks
  const allPiPaths = [
    ...(Array.isArray(pi.skills) ? pi.skills : []),
    ...(Array.isArray(pi.extensions) ? pi.extensions : []),
  ];
  for (const entry of allPiPaths) {
    if (typeof entry !== "string") continue;
    const resolved = path.resolve(repoRoot, entry);
    let isDir = false;
    try {
      isDir = statSync(resolved).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) {
      ok(`pi path resolves to existing directory: ${entry}`);
    } else {
      fail(`pi path resolves to existing directory: ${entry}`, `→ ${resolved}`);
    }
  }
} else {
  fail("package.json: pi is a plain object", JSON.stringify(pi));
}

// README install line check
if (version !== null) {
  const installPattern = `@v${version}`;
  const hasInstall =
    readme.split("\n").some(
      (line) => line.includes("pi install git:") && line.includes(installPattern)
    );
  if (hasInstall) {
    ok(`README.md: contains canonical install line with @v${version}`);
  } else {
    fail(`README.md: contains canonical install line with @v${version}`, "line with `pi install git:...@v${version}` not found");
  }
}

// CHANGELOG header check
if (version !== null) {
  const changelogHeader = `## [${version}]`;
  const hasHeader = changelog.split("\n").some((line) => line.includes(changelogHeader));
  if (hasHeader) {
    ok(`CHANGELOG.md: contains header ## [${version}]`);
  } else {
    fail(`CHANGELOG.md: contains header ## [${version}]`, `line containing \`${changelogHeader}\` not found`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION C: Release checklist sentinel guard
// Verifies that docs/checklists/v0.2.0-release.md exists and contains the
// exact sentinel string so the checklist is never accidentally stripped.
// ─────────────────────────────────────────────────────────────────────────────

const CHECKLIST_REL = "docs/checklists/v0.2.0-release.md";
const CHECKLIST_SENTINEL = "<!-- v0.2.0-release-checklist -->";

// Pure helper: checkChecklist({ root?, content? }) → { errors: string[] }
// - root: if provided, reads the file from disk and checks for sentinel
// - content: if provided (and root is null), checks the string directly
function checkChecklist({ root = null, content = null }) {
  const errors = [];

  let text = content;

  if (root !== null) {
    const filePath = path.resolve(root, CHECKLIST_REL);
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      errors.push(`file not found: ${filePath}`);
      return { errors };
    }
  }

  if (typeof text !== "string" || !text.includes(CHECKLIST_SENTINEL)) {
    errors.push(`sentinel not found: expected ${JSON.stringify(CHECKLIST_SENTINEL)}`);
  }

  return { errors };
}

console.log("\n=== Section C: Release checklist fixture tests ===");

// Helper: assert checkChecklist returns at least one error containing needle
function assertChecklistFails(label, args, needle) {
  const { errors } = checkChecklist(args);
  if (errors.length === 0) {
    fail(label, "expected at least one error, got none");
    return;
  }
  if (needle && !errors.some((e) => e.includes(needle))) {
    fail(label, `expected error containing ${JSON.stringify(needle)}, got: ${JSON.stringify(errors)}`);
    return;
  }
  ok(label);
}

function assertChecklistPasses(label, args) {
  const { errors } = checkChecklist(args);
  if (errors.length === 0) {
    ok(label);
  } else {
    fail(label, `expected no errors, got: ${JSON.stringify(errors)}`);
  }
}

// C-F1: missing file in an empty temporary root fails with "file not found"
{
  let tmpDir;
  try {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "checklist-test-"));
    assertChecklistFails(
      "C-F1: missing checklist file fails with file not found",
      { root: tmpDir },
      "file not found"
    );
  } finally {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}

// C-F2: content with no sentinel fails with "sentinel not found"
assertChecklistFails(
  "C-F2: content with no sentinel fails",
  { root: null, content: "# Release Checklist\n\nNo sentinel here.\n" },
  "sentinel not found"
);

// C-F3: wrong version sentinel fails
assertChecklistFails(
  "C-F3: wrong version sentinel fails",
  { root: null, content: "<!-- v0.1.0-release-checklist -->\n# old checklist" },
  "sentinel not found"
);

// C-F4: exact sentinel passes
assertChecklistPasses(
  "C-F4: exact sentinel passes",
  { root: null, content: CHECKLIST_SENTINEL + "\n# Release Checklist" }
);

// C-F5: sentinel anywhere in file passes
assertChecklistPasses(
  "C-F5: sentinel anywhere in file passes",
  { root: null, content: "# Release Checklist\n\nSome text.\n\n" + CHECKLIST_SENTINEL + "\n\nMore text." }
);

console.log("\n=== Section C: Live checklist validation ===");

// C-L1: checklist file is readable
let checklistContent;
try {
  checklistContent = readFileSync(path.join(repoRoot, CHECKLIST_REL), "utf8");
  ok("C-L1: checklist file readable");
} catch (e) {
  fail("C-L1: checklist file readable", e.message);
  checklistContent = null;
}

// C-L2: checkChecklist({ root: repoRoot }) returns no errors
const { errors: checklistErrors } = checkChecklist({ root: repoRoot });
if (checklistErrors.length === 0) {
  ok("C-L2: checkChecklist({ root: repoRoot }) returns no errors");
} else {
  fail("C-L2: checkChecklist({ root: repoRoot }) returns no errors", JSON.stringify(checklistErrors));
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log("\n─────────────────────────────────────────────────────────────────────────────");
console.log(`Results: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) process.exit(1);
