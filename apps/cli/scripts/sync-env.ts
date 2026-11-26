// Rebuilds .env from .env.example, keeping every value already set in .env.
// The layout and comments come from .env.example. Settings that aren't in it
// (e.g. your own MCP_<NAME>_URL) are kept, next to their section. The old file
// is saved as .env.backup. Run with `pnpm env:sync` (add --dry-run to preview).

import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseEnv } from "node:util";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const envPath = `${root}.env`;
const examplePath = `${root}.env.example`;
const dryRun = process.argv.includes("--dry-run");

const KEY = /^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/;

if (!existsSync(envPath)) {
  console.log("No .env yet: copy .env.example to .env and fill it in.");
  process.exit(0);
}
const oldText = readFileSync(envPath, "utf8");
const example = readFileSync(examplePath, "utf8").split("\n");

// Raw `KEY=value` lines from .env, last one winning, as when Node loads it.
const yours = new Map<string, string>();
for (const line of oldText.split("\n")) {
  const m = KEY.exec(line);
  if (m && !m[1]) yours.set(m[2]!, line);
}

const out: string[] = [];
const used = new Set<string>();
const added: string[] = [];
for (const line of example) {
  const m = KEY.exec(line);
  const key = m?.[2];
  if (key && yours.has(key)) {
    out.push(yours.get(key)!);
    used.add(key);
  } else {
    out.push(line);
    if (key && !m[1]) added.push(key);
  }
}

// Your other settings go after the last line of their section (same prefix, e.g. MCP_), else at the end.
const extra = [...yours.keys()].filter((k) => !used.has(k));
const prefix = (key: string) => key.split("_")[0];
const orphans: string[] = [];
for (const key of extra) {
  let at = -1;
  out.forEach((line, i) => {
    const k = KEY.exec(line)?.[2];
    if (k && prefix(k) === prefix(key)) at = i;
  });
  if (at === -1) orphans.push(yours.get(key)!);
  else out.splice(at + 1, 0, yours.get(key)!);
}
if (orphans.length) out.push("", "# --- Your other settings (not in .env.example) ---", ...orphans);
const newText = out.join("\n").replace(/\n*$/, "\n");

// Every value you set must mean exactly the same after the sync.
const before = parseEnv(oldText);
const after = parseEnv(newText);
const changed = Object.keys(before).filter((k) => !isDeepStrictEqual(before[k], after[k]));
if (changed.length) {
  console.error(`Not syncing: these would change: ${changed.join(", ")}. .env is untouched.`);
  process.exit(1);
}

console.log(`Kept ${Object.keys(before).length} settings from .env.`);
if (extra.length) console.log(`Kept settings that aren't in .env.example: ${extra.join(", ")}.`);
console.log(added.length ? `Added from .env.example: ${added.join(", ")}.` : "Nothing new in .env.example.");
if (newText === oldText) {
  console.log(".env is already in sync.");
} else if (dryRun) {
  console.log("Dry run: .env not changed.");
} else {
  copyFileSync(envPath, `${root}.env.backup`);
  chmodSync(`${root}.env.backup`, 0o600);
  writeFileSync(envPath, newText, { mode: 0o600 });
  chmodSync(envPath, 0o600);
  console.log("Wrote .env (old one saved as .env.backup).");
}
