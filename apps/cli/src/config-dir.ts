import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Local settings: prefs and the VMs' SSH host keys. Before the rename to
// Convoy they lived in ~/.config/agent-vm, so move that folder over once.
export const CONFIG_DIR = join(homedir(), ".config", "convoy");
const OLD_CONFIG_DIR = join(homedir(), ".config", "agent-vm");

export function configDir(): string {
  if (!existsSync(CONFIG_DIR) && existsSync(OLD_CONFIG_DIR)) renameSync(OLD_CONFIG_DIR, CONFIG_DIR);
  mkdirSync(CONFIG_DIR, { recursive: true });
  return CONFIG_DIR;
}
