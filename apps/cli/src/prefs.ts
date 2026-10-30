import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ALL_TOOL_IDS, type ToolId } from "@agent-platform/core";

// The user's last launch choices. .env values are only the first-run defaults.
const PREFS_PATH = join(homedir(), ".config", "agent-vm", "prefs.json");

export interface LaunchPrefs {
  region: string;
  size: string;
  tools: ToolId[];
}

interface PrefsFile {
  tools?: string[];
  // Region and size slugs are provider-specific.
  providers?: Record<string, { region?: string; size?: string }>;
}

function readPrefs(): PrefsFile {
  try {
    return JSON.parse(readFileSync(PREFS_PATH, "utf8")) as PrefsFile;
  } catch {
    return {};
  }
}

export function loadLaunchPrefs(provider: string, defaults: { region: string; size: string }): LaunchPrefs {
  const prefs = readPrefs();
  const saved = prefs.providers?.[provider] ?? {};
  // Drop tools that no longer exist in the catalog.
  const tools = prefs.tools?.filter((id): id is ToolId => ALL_TOOL_IDS.includes(id as ToolId));
  return {
    region: saved.region ?? defaults.region,
    size: saved.size ?? defaults.size,
    tools: tools ?? ALL_TOOL_IDS,
  };
}

export function saveLaunchPrefs(provider: string, { region, size, tools }: LaunchPrefs): void {
  const prefs = readPrefs();
  prefs.tools = tools;
  prefs.providers = { ...prefs.providers, [provider]: { region, size } };
  try {
    mkdirSync(dirname(PREFS_PATH), { recursive: true });
    writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2) + "\n");
  } catch {
    // Remembering choices is a convenience; never block a launch on it.
  }
}
