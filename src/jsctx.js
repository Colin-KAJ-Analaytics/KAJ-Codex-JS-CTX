import fs from "node:fs";
import path from "node:path";

const JS_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  ".turbo",
  ".cache",
  "__generated__",
  "generated",
]);

export async function main(argv) {
  const { command, target, options } = parseArgs(argv);
  let result;
  switch (command) {
    case "map":
      result = scanProject(target, options);
      break;
    case "symbols":
      result = analyzeFile(target, options);
      break;
    case "slice":
      result = sliceSymbol(target, options);
      break;
    case "imports":
      result = importGraph(target, options);
      break;
    case "routes":
      result = routeMap(target, options);
      break;
    case "search":
      result = searchSymbols(target, options);
      break;
    case "help":
      return help();
    default:
      throw new Error(`unknown command "${command}". Run kaj-js-ctx help.`);
  }
  return print(fitToBudget(result, options), options);
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() || "help";
  const options = {
    format: "text",
    maxFiles: 120,
    maxResults: 50,
    tokenBudget: 4000,
    context: 4,
    depth: 1,
    symbol: "",
    withSlices: false,
    showFiles: true,
  };
  let target = ".";
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--format") options.format = args.shift() || "text";
    else if (arg === "--max-files") options.maxFiles = numberOption(args.shift(), "--max-files", 1, 10000);
    else if (arg === "--max-results") options.maxResults = numberOption(args.shift(), "--max-results", 1, 10000);
    else if (arg === "--token-budget") options.tokenBudget = numberOption(args.shift(), "--token-budget", 100, 100000);
    else if (arg === "--context") options.context = numberOption(args.shift(), "--context", 0, 1000);
    else if (arg === "--depth") options.depth = numberOption(args.shift(), "--depth", 0, 100);
    else if (arg === "--symbol") options.symbol = args.shift() || "";
    else if (arg === "--with-slices") options.withSlices = true;
    else if (arg === "--no-files") options.showFiles = false;
    else if (arg === "-h" || arg === "--help") return { command: "help", target, options };
    else if (!target || target === ".") target = arg;
    else throw new Error(`unexpected argument "${arg}"`);
  }
  if (!["text", "json", "jsonl"].includes(options.format)) {
    throw new Error(`invalid --format "${options.format}"; use text, json, or jsonl`);
  }
  return { command, target, options };
}

function numberOption(value, name, min, max) {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error(`${name} requires an integer from ${min} to ${max}`);
  }
  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    throw new Error(`${name} must be from ${min} to ${max}`);
  }
  return parsed;
}

function help() {
  console.log(`kaj-js-ctx

Usage:
  kaj-js-ctx map <dir> [--format text|json|jsonl] [--max-files 120]
  kaj-js-ctx symbols <file> [--format text|json|jsonl]
  kaj-js-ctx slice <file> --symbol <name> [--context 4]
  kaj-js-ctx imports <file-or-dir> [--depth 1]
  kaj-js-ctx routes <dir>
  kaj-js-ctx search <dir> --symbol <name> [--with-slices]

Common limits:
  --token-budget 4000   Maximum estimated output tokens
  --max-results 50      Maximum search/route/import results
  --no-files            Omit project file details and follow-up commands

Purpose:
  Produce compact JavaScript/TypeScript context before reading full files.
`);
}

function print(value, options) {
  if (options.format === "json" || options.format === "jsonl") {
    console.log(JSON.stringify(value));
    return;
  }
  console.log(renderText(value));
}

function scanProject(rootInput, options = {}) {
  const root = absolute(rootInput);
  const files = listJSFiles(root);
  const fileStats = files.map((file) => {
    const text = fs.readFileSync(file, "utf8");
    const analysis = analyzeText(file, text);
    return {
      path: rel(root, file),
      language: languageFor(file),
      lines: analysis.lines.length,
      bytes: Buffer.byteLength(text),
      estimatedTokens: estimateTokens(text),
      imports: analysis.imports.length,
      exports: analysis.exports.length,
      symbols: analysis.symbols.length,
      routes: analysis.routes.length,
      apiCalls: analysis.apiCalls.length,
      kind: classifyFile(file, analysis),
    };
  });
  fileStats.sort((a, b) => {
    const rank = kindRank(a.kind) - kindRank(b.kind);
    if (rank !== 0) return rank;
    return b.estimatedTokens - a.estimatedTokens;
  });

  const rawTokens = sum(fileStats, "estimatedTokens");
  const payload = {
    type: "project-map",
    root,
    filesScanned: files.length,
    rawEstimatedTokens: rawTokens,
    mapEstimatedTokens: 0,
    estimatedReduction: 0,
    languages: groupBy(fileStats, "language"),
    topFiles: options.showFiles === false ? [] : fileStats.slice(0, options.maxFiles || 120),
    suggestedNextCommands: options.showFiles === false ? [] : suggestNextCommands(root, fileStats),
  };
  payload.mapEstimatedTokens = estimateTokens(renderText({ ...payload, mapEstimatedTokens: 0, estimatedReduction: 0 }));
  payload.estimatedReduction = reduction(rawTokens, payload.mapEstimatedTokens);
  return payload;
}

function analyzeFile(fileInput) {
  const file = absolute(fileInput);
  const text = fs.readFileSync(file, "utf8");
  const analysis = analyzeText(file, text);
  const rawTokens = estimateTokens(text);
  const payload = {
    type: "file-symbols",
    file,
    language: languageFor(file),
    lines: analysis.lines.length,
    rawEstimatedTokens: rawTokens,
    mapEstimatedTokens: 0,
    estimatedReduction: 0,
    imports: analysis.imports,
    exports: analysis.exports,
    symbols: analysis.symbols,
    routes: analysis.routes,
    apiCalls: analysis.apiCalls,
  };
  payload.mapEstimatedTokens = estimateTokens(renderText({ ...payload, mapEstimatedTokens: 0, estimatedReduction: 0 }));
  payload.estimatedReduction = reduction(rawTokens, payload.mapEstimatedTokens);
  return payload;
}

function sliceSymbol(fileInput, options) {
  if (!options.symbol) throw new Error("slice requires --symbol <name>");
  const file = absolute(fileInput);
  const text = fs.readFileSync(file, "utf8");
  const analysis = analyzeText(file, text);
  const match = analysis.symbols.find((s) => s.name === options.symbol);
  if (!match) throw new Error(`symbol "${options.symbol}" not found in ${file}`);
  const start = Math.max(1, match.startLine - (options.context || 4));
  const end = Math.min(analysis.lines.length, match.endLine + (options.context || 4));
  const source = analysis.lines.slice(start - 1, end).map((line, index) => {
    return `${String(start + index).padStart(4, " ")} | ${line}`;
  }).join("\n");
  const rawTokens = estimateTokens(text);
  const sliceTokens = estimateTokens(source);
  return {
    type: "symbol-slice",
    file,
    symbol: match,
    startLine: start,
    endLine: end,
    rawEstimatedTokens: rawTokens,
    sliceEstimatedTokens: sliceTokens,
    estimatedReduction: reduction(rawTokens, sliceTokens),
    source,
  };
}

function importGraph(targetInput, options) {
  const target = absolute(targetInput);
  const roots = fs.statSync(target).isDirectory() ? listJSFiles(target).slice(0, options.maxFiles || 120) : [target];
  const maxDepth = Math.max(0, options.depth || 1);
  const visited = new Set();
  const edges = [];
  const queue = roots.map((file) => ({ file, depth: 0 }));
  while (queue.length > 0) {
    const { file, depth } = queue.shift();
    if (visited.has(file) || depth > maxDepth || !fs.existsSync(file)) continue;
    visited.add(file);
    const analysis = analyzeText(file, fs.readFileSync(file, "utf8"));
    for (const imp of analysis.imports) {
      const resolved = resolveLocalImport(file, imp.source);
      edges.push({ from: file, source: imp.source, resolved, line: imp.line });
      if (resolved && depth < maxDepth) queue.push({ file: resolved, depth: depth + 1 });
    }
  }
  return { type: "import-graph", target, depth: maxDepth, filesVisited: visited.size, edges: edges.slice(0, options.maxResults || 50), totalEdges: edges.length };
}

function routeMap(rootInput, options = {}) {
  const root = absolute(rootInput);
  const files = listJSFiles(root);
  const routes = [];
  const apiCalls = [];
  for (const file of files) {
    const analysis = analyzeText(file, fs.readFileSync(file, "utf8"));
    for (const route of analysis.routes) routes.push({ file: rel(root, file), ...route });
    for (const call of analysis.apiCalls) apiCalls.push({ file: rel(root, file), ...call });
  }
  const rawTokens = estimateTokens(JSON.stringify(routes)) + estimateTokens(JSON.stringify(apiCalls));
  const limit = options.maxResults || 50;
  const payload = { type: "routes", root, routeCount: routes.length, apiCallCount: apiCalls.length, routes: routes.slice(0, limit), apiCalls: apiCalls.slice(0, limit) };
  payload.mapEstimatedTokens = estimateTokens(renderText(payload));
  payload.rawHintTokens = rawTokens;
  return payload;
}

function searchSymbols(rootInput, options) {
  if (!options.symbol) throw new Error("search requires --symbol <name>");
  const root = absolute(rootInput);
  const matches = [];
  for (const file of listJSFiles(root)) {
    const text = fs.readFileSync(file, "utf8");
    const analysis = analyzeText(file, text);
    for (const symbol of analysis.symbols) {
      if (symbol.name.includes(options.symbol)) {
        const item = { file: rel(root, file), symbol };
        if (options.withSlices) {
          const start = Math.max(1, symbol.startLine - (options.context || 4));
          const end = Math.min(analysis.lines.length, symbol.endLine + (options.context || 4));
          item.source = analysis.lines.slice(start - 1, end).map((line, index) => {
            return `${String(start + index).padStart(4, " ")} | ${line}`;
          }).join("\n");
        }
        matches.push(item);
      }
    }
  }
  return { type: "search", root, query: options.symbol, matches: matches.slice(0, options.maxResults || 50), totalMatches: matches.length };
}

function analyzeText(file, text) {
  const lines = text.split(/\r?\n/);
  const imports = [];
  const exports = [];
  const symbols = [];
  const routes = [];
  const apiCalls = [];

  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1;
    const line = lines[index];
    const trimmed = line.trim();
    const imp = matchImport(trimmed);
    if (imp) imports.push({ line: lineNo, ...imp });
    const exp = matchExport(trimmed);
    if (exp) exports.push({ line: lineNo, ...exp });
    const symbol = matchSymbol(trimmed, lineNo);
    if (symbol) {
      symbol.endLine = findEndLine(lines, index);
      symbol.kind = refineSymbolKind(symbol, lines.slice(index, Math.min(lines.length, symbol.endLine)).join("\n"));
      symbols.push(symbol);
    }
    const route = matchRoute(trimmed);
    if (route) routes.push({ line: lineNo, ...route });
    const api = matchAPICall(trimmed);
    if (api) apiCalls.push({ line: lineNo, ...api });
  }
  return { file, lines, imports, exports, symbols, routes, apiCalls };
}

function matchImport(line) {
  let m = line.match(/^import\s+(.+?)\s+from\s+["']([^"']+)["']/);
  if (m) return { specifier: compact(m[1]), source: m[2], kind: "import-from" };
  m = line.match(/^import\s+["']([^"']+)["']/);
  if (m) return { specifier: "", source: m[1], kind: "side-effect" };
  m = line.match(/(?:const|let|var)\s+(.+?)\s*=\s*require\(["']([^"']+)["']\)/);
  if (m) return { specifier: compact(m[1]), source: m[2], kind: "require" };
  return null;
}

function matchExport(line) {
  let m = line.match(/^export\s+default\s+(?:function\s+)?([A-Za-z_$][\w$]*)?/);
  if (m) return { name: m[1] || "default", kind: "default" };
  m = line.match(/^export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/);
  if (m) return { name: m[1], kind: "declaration" };
  m = line.match(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
  if (m) return { name: m[1], kind: "variable" };
  m = line.match(/^export\s*\{([^}]+)\}/);
  if (m) return { name: compact(m[1]), kind: "named-list" };
  return null;
}

function matchSymbol(line, lineNo) {
  const controlKeywords = new Set(["if", "for", "while", "switch", "catch", "with"]);
  const patterns = [
    [/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/, "function"],
    [/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/, "class"],
    [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/, "arrow-function"],
    [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/, "function-expression"],
    [/^([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?\([^)]*\)\s*=>/, "object-method"],
    [/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/, "method"],
  ];
  for (const [regex, kind] of patterns) {
    const m = line.match(regex);
    if (m && !controlKeywords.has(m[1])) return { name: m[1], kind, startLine: lineNo, endLine: lineNo };
  }
  return null;
}

function refineSymbolKind(symbol, body) {
  if (/^use[A-Z]/.test(symbol.name)) return "hook";
  if (/^[A-Z]/.test(symbol.name) && /<\w+|return\s*\(|return\s*</s.test(body)) return "react-component";
  return symbol.kind;
}

function matchRoute(line) {
  let m = line.match(/\b(?:app|router|server)\.(get|post|put|patch|delete|all)\s*\(\s*["'`]([^"'`]+)["'`]/i);
  if (m) return { kind: "server-route", method: m[1].toUpperCase(), path: m[2] };
  m = line.match(/<Route\b[^>]*\bpath=["']([^"']+)["'][^>]*(?:\belement=\{?<?([A-Za-z_$][\w$]*)?)?/);
  if (m) return { kind: "react-route", method: "UI", path: m[1], handler: m[2] || "" };
  m = line.match(/\bpath:\s*["'`]([^"'`]+)["'`]/);
  if (m) return { kind: "route-object", method: "UI", path: m[1] };
  return null;
}

function matchAPICall(line) {
  let m = line.match(/\bfetch\s*\(\s*["'`]([^"'`]+)["'`]/);
  if (m) return { client: "fetch", target: m[1] };
  m = line.match(/\baxios\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/i);
  if (m) return { client: "axios", method: m[1].toUpperCase(), target: m[2] };
  m = line.match(/\b(?:api|client)\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/i);
  if (m) return { client: "api-client", method: m[1].toUpperCase(), target: m[2] };
  return null;
}

function findEndLine(lines, startIndex) {
  let depth = 0;
  let seenBrace = false;
  for (let i = startIndex; i < lines.length; i++) {
    const line = stripStringsAndComments(lines[i]);
    for (const ch of line) {
      if (ch === "{") {
        depth++;
        seenBrace = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (seenBrace && depth <= 0) return i + 1;
    if (!seenBrace && /;\s*$/.test(line)) return i + 1;
  }
  return startIndex + 1;
}

function stripStringsAndComments(line) {
  return line.replace(/\/\/.*$/, "").replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "\"\"");
}

function listJSFiles(root) {
  const out = [];
  walk(root, out);
  return out.sort();
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".min.js") || entry.name.endsWith(".map")) continue;
    if (JS_EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
}

function resolveLocalImport(fromFile, source) {
  if (!source.startsWith(".")) return "";
  const base = path.resolve(path.dirname(fromFile), source);
  const candidates = [
    base,
    ...[...JS_EXTENSIONS].map((ext) => `${base}${ext}`),
    ...[...JS_EXTENSIONS].map((ext) => path.join(base, `index${ext}`)),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || "";
}

function languageFor(file) {
  const ext = path.extname(file).slice(1);
  return ext.toUpperCase();
}

function classifyFile(file, analysis) {
  const base = path.basename(file);
  if (/^(main|index|app)\.[jt]sx?$/.test(base)) return "entrypoint";
  if (analysis.routes.length > 0) return "routes";
  if (analysis.apiCalls.length > 0 || /api|client/i.test(base)) return "api-client";
  if (analysis.symbols.some((s) => s.kind === "react-component")) return "react";
  if (analysis.symbols.some((s) => s.kind === "hook")) return "hooks";
  return "source";
}

function kindRank(kind) {
  return { entrypoint: 0, routes: 1, "api-client": 2, react: 3, hooks: 4, source: 5 }[kind] ?? 9;
}

function groupBy(files, key) {
  const map = new Map();
  for (const file of files) {
    const name = file[key];
    const current = map.get(name) || { name, files: 0, lines: 0, bytes: 0, estimatedTokens: 0 };
    current.files++;
    current.lines += file.lines;
    current.bytes += file.bytes;
    current.estimatedTokens += file.estimatedTokens;
    map.set(name, current);
  }
  return [...map.values()].sort((a, b) => b.estimatedTokens - a.estimatedTokens);
}

function suggestNextCommands(root, files) {
  return files.slice(0, 8).map((file) => {
    const target = path.join(root, file.path);
    if (file.symbols > 0) return `kaj-js-ctx symbols ${target}`;
    return `kaj-js-ctx imports ${target}`;
  });
}

function renderText(value) {
  switch (value.type) {
    case "project-map":
      return renderProjectMap(value);
    case "file-symbols":
      return renderFileSymbols(value);
    case "symbol-slice":
      return renderSlice(value);
    case "import-graph":
      return renderImportGraph(value);
    case "routes":
      return renderRoutes(value);
    case "search":
      return renderSearch(value);
    default:
      return JSON.stringify(value, null, 2);
  }
}

function renderProjectMap(v) {
  const lines = [
    `type: project-map`,
    `root: ${v.root}`,
    `files: ${v.filesScanned}`,
    `tokens: raw_est=${v.rawEstimatedTokens} map_est=${v.mapEstimatedTokens} reduction=${Math.round(v.estimatedReduction * 100)}%`,
    "",
    "languages:",
    ...v.languages.map((l) => `- ${l.name} files=${l.files} lines=${l.lines} tokens=${l.estimatedTokens}`),
    "",
    "top_files:",
    ...v.topFiles.map((f) => `- ${f.path} kind=${f.kind} lang=${f.language} lines=${f.lines} tokens=${f.estimatedTokens} symbols=${f.symbols} imports=${f.imports} routes=${f.routes} api_calls=${f.apiCalls}`),
    "",
    "suggested_next_commands:",
    ...v.suggestedNextCommands.map((cmd) => `- ${cmd}`),
  ];
  return lines.join("\n");
}

function renderFileSymbols(v) {
  return [
    `type: file-symbols`,
    `file: ${v.file}`,
    `language: ${v.language}`,
    `lines: ${v.lines}`,
    `tokens: raw_est=${v.rawEstimatedTokens} map_est=${v.mapEstimatedTokens} reduction=${Math.round(v.estimatedReduction * 100)}%`,
    "",
    "imports:",
    ...v.imports.map((i) => `- line=${i.line} source=${i.source} kind=${i.kind} specifier=${i.specifier}`),
    "",
    "exports:",
    ...v.exports.map((e) => `- line=${e.line} name=${e.name} kind=${e.kind}`),
    "",
    "symbols:",
    ...v.symbols.map((s) => `- ${s.name} kind=${s.kind} lines=${s.startLine}-${s.endLine}`),
    "",
    "routes:",
    ...v.routes.map((r) => `- line=${r.line} kind=${r.kind} method=${r.method} path=${r.path} handler=${r.handler || ""}`),
    "",
    "api_calls:",
    ...v.apiCalls.map((a) => `- line=${a.line} client=${a.client} method=${a.method || ""} target=${a.target}`),
  ].join("\n");
}

function renderSlice(v) {
  return [
    `type: symbol-slice`,
    `file: ${v.file}`,
    `symbol: ${v.symbol.name} kind=${v.symbol.kind} lines=${v.symbol.startLine}-${v.symbol.endLine}`,
    `slice: ${v.startLine}-${v.endLine}`,
    `tokens: raw_est=${v.rawEstimatedTokens} slice_est=${v.sliceEstimatedTokens} reduction=${Math.round(v.estimatedReduction * 100)}%`,
    "",
    v.source,
  ].join("\n");
}

function renderImportGraph(v) {
  return [
    `type: import-graph`,
    `target: ${v.target}`,
    `depth: ${v.depth}`,
    `files_visited: ${v.filesVisited}`,
    "",
    "edges:",
    ...v.edges.map((e) => `- ${e.from}:${e.line} -> ${e.source}${e.resolved ? ` (${e.resolved})` : ""}`),
  ].join("\n");
}

function renderRoutes(v) {
  return [
    `type: routes`,
    `root: ${v.root}`,
    `routes: ${v.routeCount}`,
    `api_calls: ${v.apiCallCount}`,
    "",
    "routes:",
    ...v.routes.map((r) => `- ${r.file}:${r.line} ${r.method} ${r.path} kind=${r.kind} handler=${r.handler || ""}`),
    "",
    "api_calls:",
    ...v.apiCalls.map((a) => `- ${a.file}:${a.line} ${a.method || ""} ${a.target} client=${a.client}`),
  ].join("\n");
}

function renderSearch(v) {
  const lines = [`type: search`, `root: ${v.root}`, `query: ${v.query}`, `matches: ${v.matches.length}`, ""];
  for (const m of v.matches) {
    lines.push(`- ${m.file} ${m.symbol.name} kind=${m.symbol.kind} lines=${m.symbol.startLine}-${m.symbol.endLine}`);
    if (m.source) lines.push(m.source, "");
  }
  return lines.join("\n");
}

function absolute(input) {
  return path.resolve(process.cwd(), input || ".");
}

function rel(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function compact(value) {
  return value.replace(/\s+/g, " ").trim();
}

function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(text || "", "utf8") / 4);
}

function reduction(raw, compactTokens) {
  if (!raw || raw <= 0) return 0;
  return Math.max(0, Math.round((1 - compactTokens / raw) * 100) / 100);
}

function sum(values, key) {
  return values.reduce((total, value) => total + value[key], 0);
}

function fitToBudget(value, options) {
  const candidate = clone(value);
  const budget = options.tokenBudget || 4000;
  let truncated = false;

  for (let attempt = 0; attempt < 12; attempt++) {
    const measured = estimateOutput(candidate, options);
    if (measured <= budget) {
      return { ...candidate, estimatedTokens: measured, tokenBudget: budget, truncated };
    }
    if (!trimCandidate(candidate)) break;
    truncated = true;
  }

  return { ...candidate, estimatedTokens: estimateOutput(candidate, options), tokenBudget: budget, truncated: true };
}

function trimCandidate(candidate) {
  if (typeof candidate.source === "string" && candidate.source.length > 160) {
    const lines = candidate.source.split("\n");
    candidate.source = lines.slice(0, Math.max(1, Math.floor(lines.length * 0.7))).join("\n") + "\n... [truncated]";
    return true;
  }

  const arrayKeys = ["matches", "edges", "topFiles", "suggestedNextCommands", "routes", "apiCalls", "symbols", "imports", "exports"];
  for (const key of arrayKeys) {
    if (Array.isArray(candidate[key]) && candidate[key].length > 1) {
      candidate[key] = candidate[key].slice(0, Math.max(1, Math.floor(candidate[key].length * 0.7)));
      return true;
    }
  }

  for (const key of ["source", "root", "file", "target"]) {
    if (typeof candidate[key] === "string" && candidate[key].length > 80) {
      candidate[key] = `${candidate[key].slice(0, 77)}...`;
      return true;
    }
  }
  return false;
}

function estimateOutput(value, options) {
  const output = options.format === "text" ? renderText(value) : JSON.stringify(value);
  return estimateTokens(output);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
