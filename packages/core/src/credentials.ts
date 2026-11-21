import { CLEAR_GIT_IDENTITY, GITHUB_SIGN_IN, githubTokenLines } from "./github";
import { TAILSCALE_SIGN_IN } from "./tailscale";
import { AGENT_TOOLS, type ToolId } from "./tools";

// API keys copied onto VMs so agent tools work without signing in on each one.
//
// Only API keys are automated. Anthropic's terms don't allow tools to collect
// or pass around Claude subscription logins, so Claude Code on an agent VM
// always uses an Anthropic API key. OpenAI asks that one Codex login
// (~/.codex/auth.json) not be shared across machines, so a ChatGPT-plan login
// is done per VM with `codex login --device-auth`.

/**
 * How agent tools on a new VM sign in:
 * - subscription: you sign in yourself on each VM with your own Claude or
 *   ChatGPT plan, through the vendor's login flow (`l` in the TUI).
 * - api-keys: the API keys in .env are installed on boot. For swarms.
 */
export type SignInMode = "subscription" | "api-keys";

export interface AgentKeys {
  anthropic?: string;
  openai?: string;
  /** Tailscale auth key, used in either sign-in mode to join VMs to the tailnet. */
  tailscale?: string;
  /**
   * GitHub token (ideally fine-grained, limited to the repos agents need).
   * Installed in either sign-in mode: it isn't a Claude or ChatGPT login.
   */
  github?: string;
  /** MCP servers agents connect to, from MCP_<NAME>_URL (+ MCP_<NAME>_TOKEN). Installed in either sign-in mode. */
  mcp?: McpServer[];
}

/** A Streamable HTTP MCP server registered with Claude Code and Codex on VMs. */
export interface McpServer {
  /** Lowercase name tools know it by, e.g. "shyup" from MCP_SHYUP_URL. */
  name: string;
  url: string;
  /** Environment variable on the VM holding the bearer token, e.g. MCP_SHYUP_TOKEN. */
  tokenVar?: string;
  token?: string;
}

/** MCP servers from MCP_<NAME>_URL and optional MCP_<NAME>_TOKEN in .env. */
export function mcpServersFromEnv(env: NodeJS.ProcessEnv = process.env): McpServer[] {
  const servers: McpServer[] = [];
  for (const [key, value] of Object.entries(env)) {
    const match = /^MCP_([A-Z0-9_]+)_URL$/.exec(key);
    const url = value?.trim();
    if (!match || !url) continue;
    if (!/^https?:\/\//.test(url)) throw new Error(`${key} must be an http(s) URL.`);
    const tokenVar = `MCP_${match[1]}_TOKEN`;
    const token = env[tokenVar]?.trim() || undefined;
    servers.push({ name: match[1]!.toLowerCase().replace(/_/g, "-"), url, ...(token ? { tokenVar, token } : {}) });
  }
  return servers.sort((a, b) => a.name.localeCompare(b.name));
}

export function agentKeysFromEnv(env: NodeJS.ProcessEnv = process.env): AgentKeys {
  return {
    anthropic: env.ANTHROPIC_API_KEY?.trim() || undefined,
    openai: env.OPENAI_API_KEY?.trim() || undefined,
    tailscale: env.TAILSCALE_AUTH_KEY?.trim() || undefined,
    github: env.GITHUB_TOKEN?.trim() || undefined,
    mcp: mcpServersFromEnv(env),
  };
}

/** Why a tool can't be launched with these keys, or null if it can. */
export function missingKey(tool: ToolId, keys: AgentKeys, mode: SignInMode): string | null {
  if (mode === "api-keys" && tool === "claude-code" && !keys.anthropic) return "needs ANTHROPIC_API_KEY in .env";
  return null;
}

export function assertKeysFor(tools: ToolId[], keys: AgentKeys, mode: SignInMode): void {
  const missing = tools.filter((tool) => missingKey(tool, keys, mode));
  if (missing.length === 0) return;
  const names = missing.map((id) => AGENT_TOOLS.find((tool) => tool.id === id)!.name).join(", ");
  throw new Error(
    `${names} needs ANTHROPIC_API_KEY in .env (see .env.example) when launching with API keys. ` +
      "To use your Claude subscription instead, launch with subscription sign-in and sign in on the VM.",
  );
}

/** How a tool will authenticate on a new VM, for display. */
export function keyStatus(tool: ToolId, keys: AgentKeys, mode: SignInMode): { text: string; ok: boolean } | null {
  if (mode === "subscription") {
    return tool === "agent-browser" ? null : { text: "sign in on the VM", ok: true };
  }
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
 * keys, signs gh and git in with the GitHub token, and sets the commit
 * identity from the token's account (or clears it without one). It contains the keys, so run it with `bash -s` over SSH (stdin),
 * never as a command-line argument or in cloud-init user data. Returns null if
 * Pass only the keys the sign-in mode allows.
 */
export function keySetupScript(keys: AgentKeys): string {
  const lines = [
    "set -euo pipefail",
    "umask 077",
    'export PATH="$HOME/.local/bin:$PATH"',
    'keys="$HOME/.config/convoy"',
    'mkdir -p "$keys"',
    // Sets one key in a JSON config file, keeping the rest of it.
    'json_set() { local file="$1"; shift; mkdir -p "$(dirname "$file")"; [ -s "$file" ] || echo "{}" > "$file"; jq "$@" "$file" > "$file.tmp"; mv "$file.tmp" "$file"; }',
  ];
  if (keys.anthropic) {
    lines.push(
      `printf '%s' ${shellQuote(keys.anthropic)} > "$keys/anthropic-api-key"`,
      // apiKeyHelper rather than ANTHROPIC_API_KEY: no approval prompt, and the key stays out of every process's environment.
      'if command -v claude >/dev/null; then json_set "$HOME/.claude/settings.json" --arg helper "cat $keys/anthropic-api-key" \'.apiKeyHelper = $helper\'; fi',
      'if command -v opencode >/dev/null; then json_set "$HOME/.config/opencode/opencode.json" \'.provider.anthropic.options.apiKey = "{file:~/.config/convoy/anthropic-api-key}"\'; fi',
    );
  }
  if (keys.openai) {
    lines.push(
      `printf '%s' ${shellQuote(keys.openai)} > "$keys/openai-api-key"`,
      'if command -v codex >/dev/null; then codex login --with-api-key < "$keys/openai-api-key" >/dev/null; fi',
      'if command -v opencode >/dev/null; then json_set "$HOME/.config/opencode/opencode.json" \'.provider.openai.options.apiKey = "{file:~/.config/convoy/openai-api-key}"\'; fi',
    );
  }
  lines.push(...(keys.github ? githubTokenLines(keys.github) : CLEAR_GIT_IDENTITY));
  lines.push(...mcpLines(keys.mcp ?? []));
  return lines.join("\n") + "\n";
}

/**
 * Bash lines that register MCP servers with Claude Code and Codex for the agent
 * user. Tokens go only in ~/.config/convoy/env (mode 600), which ~/.bashrc
 * loads; both tools read them from the environment, so they're never on a
 * command line or in a tool's config. Servers Convoy added before and that are
 * no longer in .env are removed.
 */
function mcpLines(servers: McpServer[]): string[] {
  const source = '[ -f "$HOME/.config/convoy/env" ] && . "$HOME/.config/convoy/env"';
  const lines = [
    `printf '' > "$keys/env"`,
    ...servers.filter((s) => s.token).map((s) => `printf '%s\\n' ${shellQuote(`export ${s.tokenVar}=${shellQuote(s.token!)}`)} >> "$keys/env"`),
    `grep -qxF ${shellQuote(source)} "$HOME/.bashrc" 2>/dev/null || printf '%s\\n' ${shellQuote(source)} >> "$HOME/.bashrc"`,
    // Forget servers Convoy registered earlier that aren't wanted any more.
    `for old in $(cat "$keys/mcp-servers" 2>/dev/null); do`,
    `  case " ${servers.map((s) => s.name).join(" ")} " in *" $old "*) ;; *)`,
    '    if command -v claude >/dev/null; then claude mcp remove -s user "$old" >/dev/null 2>&1 || true; fi',
    '    if command -v codex >/dev/null; then codex mcp remove "$old" >/dev/null 2>&1 || true; fi ;;',
    "  esac",
    "done",
    `printf '%s\\n' ${servers.map((s) => shellQuote(s.name)).join(" ") || "''"} | grep . > "$keys/mcp-servers" || true`,
  ];
  for (const s of servers) {
    const name = shellQuote(s.name);
    const url = shellQuote(s.url);
    const header = s.tokenVar ? ` -H ${shellQuote(`Authorization: Bearer \${${s.tokenVar}}`)}` : "";
    const bearer = s.tokenVar ? ` --bearer-token-env-var ${s.tokenVar}` : "";
    lines.push(
      `if command -v claude >/dev/null; then claude mcp remove -s user ${name} >/dev/null 2>&1 || true; claude mcp add -s user --transport http ${name} ${url}${header} >/dev/null; fi`,
      `if command -v codex >/dev/null; then codex mcp remove ${name} >/dev/null 2>&1 || true; codex mcp add ${name} --url ${url}${bearer} >/dev/null; fi`,
    );
  }
  return lines;
}

/** The keys a sign-in mode installs: API keys only in api-keys mode, GitHub in both. */
export function keysForMode(keys: AgentKeys, mode: SignInMode): AgentKeys {
  return mode === "api-keys" ? keys : { github: keys.github, mcp: keys.mcp };
}

/**
 * Interactive script that signs in Claude Code, Codex, GitHub and Tailscale on a VM
 * through each vendor's own login flow, skipping tools that are already signed in. Run it
 * in a terminal over `ssh -t`. Holds no secrets.
 */
export const SIGN_IN_SCRIPT = `
export PATH="$HOME/.local/bin:$PATH"
if command -v claude >/dev/null; then
  if claude auth status >/dev/null 2>&1; then
    echo "Claude Code: already signed in."
  else
    echo; echo "== Claude Code: sign in with your Claude account =="
    claude auth login || echo "Claude Code sign-in didn't finish. Retry on the VM with: claude auth login"
  fi
fi
if command -v codex >/dev/null; then
  if codex login status >/dev/null 2>&1; then
    echo "Codex: already signed in."
  else
    echo; echo "== Codex: sign in with ChatGPT =="
    echo "(Device code sign-in must be turned on in your ChatGPT security settings.)"
    codex login --device-auth || echo "Codex sign-in didn't finish. Retry on the VM with: codex login --device-auth"
  fi
fi
if command -v opencode >/dev/null; then
  echo; echo "OpenCode: add a provider on the VM with: opencode auth login"
fi
${GITHUB_SIGN_IN}
${TAILSCALE_SIGN_IN}
echo; read -rp "Press enter to go back. " _
`;
