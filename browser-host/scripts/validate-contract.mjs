#!/usr/bin/env node

/**
 * Phase 5A contract validator.
 *
 * Validates that a JSON file matches the BrowserContextSnapshot schema.
 * No dependencies — uses only Node.js built-ins.
 *
 * Usage: node scripts/validate-contract.mjs [path]
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULTS = {
  fixture: resolve(import.meta.dirname, "../test/contract-snapshot.json"),
};

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

function assert(cond, msg) {
  if (!cond) fail(msg);
}

function required(obj, key, ctx) {
  if (!(key in obj) || obj[key] === undefined) {
    fail(`${ctx}: missing required field "${key}"`);
    return false;
  }
  return true;
}

function typeCheck(val, expected, ctx) {
  const t = typeof val;
  if (t !== expected) {
    fail(`${ctx}: expected type "${expected}", got "${t}"`);
    return false;
  }
  return true;
}

function validate(path) {
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    fail(`Cannot read ${path}: ${e.message}`);
    return;
  }

  // Top-level
  required(data, "capturedAt", "root");
  typeCheck(data.capturedAt, "string", "root.capturedAt");
  required(data, "source", "root");
  required(data, "profileId", "root");
  typeCheck(data.profileId, "string", "root.profileId");
  required(data, "activeTab", "root");
  required(data, "tabs", "root");
  assert(Array.isArray(data.tabs), "root.tabs must be array");
  required(data, "recentEvents", "root");
  assert(Array.isArray(data.recentEvents), "root.recentEvents must be array");
  required(data, "permissions", "root");
  required(data, "limits", "root");

  // source
  const src = data.source;
  required(src, "provider", "source");
  assert(src.provider === "browser-host", 'source.provider must be "browser-host"');
  required(src, "mode", "source");
  assert(src.mode === "read-only", 'source.mode must be "read-only"');
  required(src, "version", "source");
  assert(["phase-3b", "phase-5a"].includes(src.version), `source.version must be "phase-3b" or "phase-5a", got "${src.version}"`);

  // activeTab
  const tab = data.activeTab;
  const tabFields = ["id", "url", "title", "pageType", "isLoading", "canGoBack", "canGoForward", "screenshotRef", "domSummary", "selectedText", "clipboardTextPreview"];
  for (const f of tabFields) {
    required(tab, f, "activeTab");
  }
  typeCheck(tab.isLoading, "boolean", "activeTab.isLoading");
  typeCheck(tab.canGoBack, "boolean", "activeTab.canGoBack");
  typeCheck(tab.canGoForward, "boolean", "activeTab.canGoForward");
  typeCheck(tab.domSummary, "string", "activeTab.domSummary");
  typeCheck(tab.selectedText, "string", "activeTab.selectedText");
  typeCheck(tab.clipboardTextPreview, "string", "activeTab.clipboardTextPreview");

  // tabs
  assert(data.tabs.length > 0, "tabs must not be empty");
  for (let i = 0; i < data.tabs.length; i++) {
    const t = data.tabs[i];
    required(t, "id", `tabs[${i}]`);
    required(t, "url", `tabs[${i}]`);
    required(t, "title", `tabs[${i}]`);
    typeCheck(t.active, "boolean", `tabs[${i}].active`);
  }

  // recentEvents
  for (let i = 0; i < data.recentEvents.length; i++) {
    const e = data.recentEvents[i];
    required(e, "ts", `recentEvents[${i}]`);
    required(e, "type", `recentEvents[${i}]`);
    typeCheck(e.ts, "string", `recentEvents[${i}].ts`);
    typeCheck(e.type, "string", `recentEvents[${i}].type`);
  }

  // permissions
  const perms = data.permissions;
  for (const k of ["screenshot", "clipboard", "dom", "selection"]) {
    required(perms, k, "permissions");
    assert(["available", "unavailable"].includes(perms[k]), `permissions.${k} must be "available" or "unavailable", got "${perms[k]}"`);
  }

  // limits
  const limits = data.limits;
  assert(limits.domSummaryChars === 3000, "limits.domSummaryChars must be 3000");
  assert(limits.selectedTextChars === 3000, "limits.selectedTextChars must be 3000");
  assert(limits.clipboardPreviewChars === 1000, "limits.clipboardPreviewChars must be 1000");

  // pluginContext — optional, must be null or object with pluginId + matched
  if ("pluginContext" in data && data.pluginContext !== null) {
    const pc = data.pluginContext;
    assert(typeof pc === "object", "pluginContext must be null or object");
    required(pc, "pluginId", "pluginContext");
    typeCheck(pc.pluginId, "string", "pluginContext.pluginId");
    required(pc, "matched", "pluginContext");
    typeCheck(pc.matched, "boolean", "pluginContext.matched");
    if (pc.pluginId === "github-pr" && pc.matched) {
      const gpr = pc.githubPullRequest;
      assert(gpr && typeof gpr === "object", "pluginContext.githubPullRequest must be object when pluginId=github-pr and matched=true");
      required(gpr, "owner", "pluginContext.githubPullRequest");
      required(gpr, "repo", "pluginContext.githubPullRequest");
      typeCheck(gpr.number, "number", "pluginContext.githubPullRequest.number");
      required(gpr, "url", "pluginContext.githubPullRequest");
      required(gpr, "title", "pluginContext.githubPullRequest");
    }
  }

  if (process.exitCode === undefined || process.exitCode === 0) {
    console.log(`PASS: ${path}`);
  }
}

const arg = process.argv[2] || DEFAULTS.fixture;
validate(arg);
