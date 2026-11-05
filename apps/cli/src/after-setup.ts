import { keysForMode, parseRepo, type AgentKeys, type CloneResult, type SignInMode } from "@agent-platform/core";
import { cloneRepos, installKeys, joinTailnet, localGitIdentity, runScript } from "./ssh";

export interface AfterSetupOptions {
  name: string;
  mode: SignInMode;
  keys: AgentKeys;
  /** Join the tailnet; "if-installed" for VMs from snapshots, which may have Tailscale. */
  tailscale: boolean | "if-installed";
  /** owner/name repos to clone (the project's). */
  repos: string[];
}

export interface AfterSetupResult {
  tailnetName: string | null;
  cloned: CloneResult[];
  /** Steps that failed, each with a command to retry it. The VM still works. */
  problems: string[];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * What happens over SSH once cloud-init is done: join the tailnet, install
 * keys and the commit identity, then clone the project's repos (after the
 * keys, so private repos work).
 */
export async function afterSetup(ip: string, options: AfterSetupOptions): Promise<AfterSetupResult> {
  const { name, mode, keys, tailscale, repos } = options;
  const result: AfterSetupResult = { tailnetName: null, cloned: [], problems: [] };
  const joinTailscale =
    tailscale === "if-installed" ? (await runScript(ip, "command -v tailscale", { timeoutMs: 30_000 })).code === 0 : tailscale;
  if (joinTailscale && keys.tailscale) {
    try {
      result.tailnetName = await joinTailnet(ip, keys.tailscale, name);
    } catch (err) {
      result.problems.push(`${errorText(err)} (retry: pnpm cli tailscale ${name})`);
    }
  }
  try {
    await installKeys(ip, keysForMode(keys, mode), localGitIdentity());
  } catch (err) {
    result.problems.push(`${errorText(err)} (retry: pnpm cli keys ${name})`);
  }
  try {
    result.cloned = await cloneRepos(ip, repos.map((slug) => ({ repo: parseRepo(slug) })));
  } catch (err) {
    result.problems.push(`${errorText(err)} (retry: pnpm cli clone ${name} <repo>)`);
  }
  for (const failed of result.cloned.filter((c) => c.status === "fail")) {
    result.problems.push(`couldn't clone ${failed.repo}: ${failed.reason ?? "unknown error"} (retry: pnpm cli clone ${name} ${failed.repo})`);
  }
  return result;
}
