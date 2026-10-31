import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ALL_TOOL_IDS, type Fleet, type SignInMode, type ToolId } from "@agent-platform/core";

// The user's last launch choices. .env values are only the first-run defaults.
const PREFS_PATH = join(homedir(), ".config", "agent-vm", "prefs.json");

export interface LaunchPrefs {
  provider: string;
  region: string;
  size: string;
  tools: ToolId[];
  signIn: SignInMode;
}

interface PrefsFile {
  provider?: string;
  tools?: string[];
  signIn?: SignInMode;
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

/** Last region and size used on this provider, else its .env defaults. */
export function placementFor(fleet: Fleet, provider: string): { region: string; size: string } {
  const saved = readPrefs().providers?.[provider] ?? {};
  const { defaults } = fleet.cloud(provider);
  return { region: saved.region ?? defaults.region, size: saved.size ?? defaults.size };
}

export function loadLaunchPrefs(fleet: Fleet): LaunchPrefs {
  const prefs = readPrefs();
  // The last-used provider may have been turned off in .env since.
  const provider =
    prefs.provider && fleet.clouds.some((c) => c.name === prefs.provider)
      ? prefs.provider
      : fleet.config.defaultProvider;
  // Drop tools that no longer exist in the catalog.
  const tools = prefs.tools?.filter((id): id is ToolId => ALL_TOOL_IDS.includes(id as ToolId));
  const signIn = prefs.signIn === "api-keys" ? "api-keys" : "subscription";
  return { provider, ...placementFor(fleet, provider), tools: tools ?? ALL_TOOL_IDS, signIn };
}

export function saveLaunchPrefs({ provider, region, size, tools, signIn }: LaunchPrefs): void {
  const prefs = readPrefs();
  prefs.provider = provider;
  prefs.tools = tools;
  prefs.signIn = signIn;
  prefs.providers = { ...prefs.providers, [provider]: { region, size } };
  try {
    mkdirSync(dirname(PREFS_PATH), { recursive: true });
    writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2) + "\n");
  } catch {
    // Remembering choices is a convenience; never block a launch on it.
  }
}
