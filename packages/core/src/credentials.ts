import { AGENT_TOOLS, type ToolId } from "./tools";

// API keys copied onto VMs so agent tools work without signing in on each one.
//
// Only API keys are automated. Anthropic's terms don't allow tools to collect
// or pass around Claude subscription logins, so Claude Code on an agent VM
// always uses an Anthropic API key. OpenAI asks that one Codex login
// (~/.codex/auth.json) not be shared across machines, so a ChatGPT-plan login
// is done per VM with `codex login --device-auth`.

export interface AgentKeys {
  anthropic?: string;
  openai?: string;
}

export function agentKeysFromEnv(env: NodeJS.ProcessEnv = process.env): AgentKeys {
  return {
    anthropic: env.ANTHROPIC_API_KEY?.trim() || undefined,
    openai: env.OPENAI_API_KEY?.trim() || undefined,
  };
}

/** Why a tool can't be launched with these keys, or null if it can. */
export function missingKey(tool: ToolId, keys: AgentKeys): string | null {
  if (tool === "claude-code" && !keys.anthropic) return "needs ANTHROPIC_API_KEY in .env";
  return null;
}

export function assertKeysFor(tools: ToolId[], keys: AgentKeys): void {
  const missing = tools.filter((tool) => missingKey(tool, keys));
  if (missing.length === 0) return;
  const names = missing.map((id) => AGENT_TOOLS.find((tool) => tool.id === id)!.name).join(", ");
  throw new Error(
    `${names} needs ANTHROPIC_API_KEY in .env (see .env.example), or launch without it. ` +
      "Claude subscription logins aren't copied to VMs, to stay within Anthropic's terms.",
  );
}

/** How a tool will authenticate on a new VM, for display. */
export function keyStatus(tool: ToolId, keys: AgentKeys): { text: string; ok: boolean } | null {
  switch (tool) {
    case "claude-code":
      return keys.anthropic ? { text: "uses your API key", ok: true } : { text: "needs ANTHROPIC_API_KEY in .env", ok: false };
    case "codex":
      return keys.openai ? { text: "uses your API key", ok: true } : { text: "sign in on the VM", ok: true };
    case "opencode":
      return keys.anthropic || keys.openai ? { text: "uses your API keys", ok: true } : { text: "sign in on the VM", ok: true };
    default:
      return null;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Bash script that configures the agent tools installed on a VM with these
 * keys. It contains the keys, so run it with `bash -s` over SSH (stdin), never
 * as a command-line argument or in cloud-init user data. Returns null if there
 * are no keys.
 */
export function keySetupScript(keys: AgentKeys): string | null {
  if (!keys.anthropic && !keys.openai) return null;
  const lines = [
    "set -euo pipefail",
    "umask 077",
    'export PATH="$HOME/.local/bin:$PATH"',
    'keys="$HOME/.config/agent-vm"',
    'mkdir -p "$keys"',
    // Sets one key in a JSON config file, keeping the rest of it.
    'json_set() { local file="$1"; shift; mkdir -p "$(dirname "$file")"; [ -s "$file" ] || echo "{}" > "$file"; jq "$@" "$file" > "$file.tmp"; mv "$file.tmp" "$file"; }',
  ];
  if (keys.anthropic) {
    lines.push(
      `printf '%s' ${shellQuote(keys.anthropic)} > "$keys/anthropic-api-key"`,
      // apiKeyHelper rather than ANTHROPIC_API_KEY: no approval prompt, and the key stays out of every process's environment.
      'if command -v claude >/dev/null; then json_set "$HOME/.claude/settings.json" --arg helper "cat $keys/anthropic-api-key" \'.apiKeyHelper = $helper\'; fi',
      'if command -v opencode >/dev/null; then json_set "$HOME/.config/opencode/opencode.json" \'.provider.anthropic.options.apiKey = "{file:~/.config/agent-vm/anthropic-api-key}"\'; fi',
    );
  }
  if (keys.openai) {
    lines.push(
      `printf '%s' ${shellQuote(keys.openai)} > "$keys/openai-api-key"`,
      'if command -v codex >/dev/null; then codex login --with-api-key < "$keys/openai-api-key" >/dev/null; fi',
      'if command -v opencode >/dev/null; then json_set "$HOME/.config/opencode/opencode.json" \'.provider.openai.options.apiKey = "{file:~/.config/agent-vm/openai-api-key}"\'; fi',
    );
  }
  return lines.join("\n") + "\n";
}
