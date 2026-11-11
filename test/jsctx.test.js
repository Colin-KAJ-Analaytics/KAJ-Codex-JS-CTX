import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

const root = path.resolve("test/fixtures/sample");
const cli = path.resolve("bin/kaj-js-ctx.js");

test("map skips generated files and reports token reduction", () => {
  const out = run("map", root, "--format", "json");
  const data = JSON.parse(out);
  assert.equal(data.type, "project-map");
  assert.equal(data.filesScanned, 3);
  assert.ok(data.rawEstimatedTokens > 0);
  assert.ok(data.mapEstimatedTokens > 0);
  assert.ok(data.topFiles.every((file) => !file.path.includes("node_modules")));
});

test("symbols detects components hooks imports routes and API calls", () => {
  const out = run("symbols", path.join(root, "src/pages/QuotesPage.tsx"), "--format", "json");
  const data = JSON.parse(out);
  assert.ok(data.imports.some((item) => item.source === "../lib/apiClient"));
  assert.ok(data.symbols.some((item) => item.name === "QuotesPage" && item.kind === "react-component"));
  assert.ok(data.symbols.some((item) => item.name === "useQuotes" && item.kind === "hook"));
  assert.ok(data.symbols.every((item) => item.name !== "if"));
  assert.ok(data.apiCalls.length >= 1);
});

test("slice returns only selected symbol source", () => {
  const out = run("slice", path.join(root, "src/pages/QuotesPage.tsx"), "--symbol", "QuotesPage");
  assert.match(out, /type: symbol-slice/);
  assert.match(out, /QuotesPage/);
  assert.match(out, /reduction=/);
});

test("routes finds React and API client hints", () => {
  const out = run("routes", root, "--format", "json");
  const data = JSON.parse(out);
  assert.ok(data.routes.some((route) => route.path === "/quotes"));
  assert.ok(data.apiCalls.some((call) => call.target === "/api/quotes"));
});

test("json output is compact and reports the token budget", () => {
  const out = run("symbols", path.join(root, "src/pages/QuotesPage.tsx"), "--format", "json", "--token-budget", "1000");
  assert.doesNotMatch(out, /\n  /);
  const data = JSON.parse(out);
  assert.equal(data.tokenBudget, 1000);
  assert.ok(data.estimatedTokens <= data.tokenBudget);
  assert.equal(data.truncated, false);
});

test("no-files omits project details", () => {
  const out = run("map", root, "--format", "json", "--no-files");
  const data = JSON.parse(out);
  assert.deepEqual(data.topFiles, []);
  assert.deepEqual(data.suggestedNextCommands, []);
});

test("invalid limits fail clearly", () => {
  assert.throws(
    () => run("map", root, "--token-budget", "not-a-number"),
    /--token-budget requires an integer/,
  );
});

function run(...args) {
  return execFileSync("node", [cli, ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
}

test("fixture exists", () => {
  assert.ok(fs.existsSync(path.join(root, "src/pages/QuotesPage.tsx")));
});
