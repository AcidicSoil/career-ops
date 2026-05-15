#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PROTECTED_EXACT = new Set(["AGENTS.md", "CLAUDE.md", "modes/_shared.md"]);

const PROTECTED_PREFIXES = ["scripts/", "templates/"];

const DIFF_FILTER = "ACDMRTUXB";

function git(args, options = {}) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      ...options
    }).trim();
  } catch {
    return "";
  }
}

function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.?\//, "");
}

function isProtected(path) {
  const normalized = normalizePath(path);

  if (PROTECTED_EXACT.has(normalized)) {
    return true;
  }

  return PROTECTED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function lines(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getProtected(files) {
  return [...new Set(files.map(normalizePath).filter(isProtected))].sort();
}

function diffFiles(args) {
  return lines(
    git(["diff", "--name-only", `--diff-filter=${DIFF_FILTER}`, ...args, "--"])
  );
}

function untrackedFiles() {
  return lines(git(["ls-files", "--others", "--exclude-standard"]));
}

function resolveDefaultBase() {
  const upstream = git([
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}"
  ]);
  if (upstream) return upstream;

  const originHead = git([
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD"
  ]);
  if (originHead) return originHead.replace(/^origin\//, "origin/");

  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    const exists = git(["rev-parse", "--verify", "--quiet", candidate]);
    if (exists) return candidate;
  }

  return "";
}

function mergeBase(refA, refB) {
  return git(["merge-base", refA, refB]);
}

function collectNormalMode() {
  const base = process.env.PROTECTED_FILES_BASE || resolveDefaultBase();

  const groups = [];

  const unstaged = getProtected(diffFiles([]));
  if (unstaged.length > 0) {
    groups.push(["unstaged changes", unstaged]);
  }

  const staged = getProtected(diffFiles(["--cached"]));
  if (staged.length > 0) {
    groups.push(["staged changes", staged]);
  }

  const untracked = getProtected(untrackedFiles());
  if (untracked.length > 0) {
    groups.push(["untracked files", untracked]);
  }

  if (base) {
    const committed = getProtected(diffFiles([`${base}...HEAD`]));
    if (committed.length > 0) {
      groups.push([`committed changes since ${base}`, committed]);
    }
  } else {
    console.warn(
      "warning: could not resolve an upstream/default branch; skipped committed-range check"
    );
  }

  return groups;
}

function isZeroSha(sha) {
  return /^0+$/.test(sha);
}

function collectPrePushMode() {
  const stdin = readFileSync(0, "utf8").trim();
  const groups = [];

  const localDirtyGroups = collectNormalMode().filter(([label]) =>
    ["unstaged changes", "staged changes", "untracked files"].includes(label)
  );

  groups.push(...localDirtyGroups);

  if (!stdin) {
    return groups;
  }

  for (const line of stdin.split(/\r?\n/).filter(Boolean)) {
    const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);

    if (!localSha || isZeroSha(localSha)) {
      continue;
    }

    let rangeLabel = "";
    let files = [];

    if (remoteSha && !isZeroSha(remoteSha)) {
      rangeLabel = `${remoteRef}: ${remoteSha.slice(0, 12)}..${localSha.slice(0, 12)}`;
      files = diffFiles([remoteSha, localSha]);
    } else {
      const base = resolveDefaultBase();
      const mb = base ? mergeBase(base, localSha) : "";

      if (mb) {
        rangeLabel = `${localRef}: ${mb.slice(0, 12)}..${localSha.slice(0, 12)} new-branch push`;
        files = diffFiles([mb, localSha]);
      } else {
        rangeLabel = `${localRef}: new-branch push`;
        files = diffFiles([localSha]);
      }
    }

    const protectedFiles = getProtected(files);
    if (protectedFiles.length > 0) {
      groups.push([rangeLabel, protectedFiles]);
    }
  }

  return groups;
}

function printFailure(groups) {
  console.error("");
  console.error("❌ Protected career-ops system-layer files were changed.");
  console.error("");
  console.error("Blocked paths:");
  console.error("  - AGENTS.md");
  console.error("  - CLAUDE.md");
  console.error("  - modes/_shared.md");
  console.error("  - scripts/**");
  console.error("  - templates/**");
  console.error("");

  for (const [label, files] of groups) {
    console.error(`${label}:`);
    for (const file of files) {
      console.error(`  - ${file}`);
    }
    console.error("");
  }

  console.error(
    "Revert these changes or get explicit approval before bypassing."
  );
  console.error("");
  console.error("Emergency bypass:");
  console.error("  ALLOW_PROTECTED_CHANGES=1 git push");
  console.error("");
}

function main() {
  if (process.env.ALLOW_PROTECTED_CHANGES === "1") {
    console.warn(
      "⚠️  ALLOW_PROTECTED_CHANGES=1 set; protected-file guard bypassed."
    );
    process.exit(0);
  }

  const prePush = process.argv.includes("--pre-push");
  const groups = prePush ? collectPrePushMode() : collectNormalMode();

  if (groups.length > 0) {
    printFailure(groups);
    process.exit(1);
  }

  console.log("✅ Protected career-ops files unchanged.");
}

main();
