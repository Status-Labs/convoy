// What's on a VM, read over SSH in one round trip for the detail view: setup
// state, tool versions, desktop, tailnet, GitHub sign-in, repos and tmux
// sessions. Holds no secrets.

/** Prints `key<TAB>value` lines. Run as the agent user. */
export const VM_INFO_SCRIPT = `
export PATH="$HOME/.local/bin:$PATH"
state=/var/lib/agent-vm
put() { printf '%s\\t%s\\n' "$1" "$2"; }
if [ -f $state/failed ]; then put setup "failed: $(cat $state/failed)"
elif [ -f $state/ready ]; then put setup ready
elif [ -f $state/phase ]; then put setup "$(cat $state/phase)"
else put setup "updating packages"; fi
ver() { command -v "$2" >/dev/null && put "tool:$1" "$("$2" --version 2>/dev/null | head -n1 | grep -oE '[0-9]+\\.[0-9]+(\\.[0-9]+)?' | head -n1)"; }
ver "Claude Code" claude
ver "Codex" codex
ver "agent-browser" agent-browser
ver "OpenCode" opencode
ver "Node.js" node
ver "Python" python3
ver "git" git
ver "gh" gh
if [ -f /etc/systemd/system/agent-vm-desktop.service ]; then put desktop "$(systemctl is-active agent-vm-desktop 2>/dev/null)"; fi
if command -v tailscale >/dev/null; then
  ts=$(tailscale status --json 2>/dev/null)
  put tailscale "$(jq -r '.BackendState // "stopped"' <<<"$ts" 2>/dev/null) $(jq -r '.Self.DNSName // ""' <<<"$ts" 2>/dev/null | sed 's/\\.$//')"
fi
if command -v gh >/dev/null; then
  if gh auth status --hostname github.com >/dev/null 2>&1; then put github "$(gh api user --jq .login 2>/dev/null || echo signed-in)"
  else put github ""; fi
fi
put identity "$(git config --global user.name 2>/dev/null) <$(git config --global user.email 2>/dev/null)>"
for d in ~/*/.git; do [ -d "$d" ] && put repo "$(basename "$(dirname "$d")")"; done
tmux ls -F '#{session_name}#{?session_attached, (attached),}' 2>/dev/null | while read -r s; do put tmux "$s"; done
true
`;

export interface VmInfo {
  /** "ready", "failed: <step>", or the current setup phase. */
  setup: string;
  tools: { name: string; version: string }[];
  /** systemd state of the desktop ("active"), or null without one. */
  desktop: string | null;
  /** null without Tailscale. */
  tailscale: { state: string; dnsName: string } | null;
  /** GitHub login gh is signed in as; "" when gh isn't signed in; null without gh. */
  github: string | null;
  /** Commit author, or null if unset. */
  identity: string | null;
  repos: string[];
  tmux: string[];
}

export function parseVmInfo(stdout: string): VmInfo {
  const info: VmInfo = { setup: "unknown", tools: [], desktop: null, tailscale: null, github: null, identity: null, repos: [], tmux: [] };
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const key = line.slice(0, tab);
    const value = line.slice(tab + 1).trim();
    if (key === "setup") info.setup = value;
    else if (key.startsWith("tool:")) info.tools.push({ name: key.slice(5), version: value });
    else if (key === "desktop") info.desktop = value;
    else if (key === "tailscale") {
      const [state = "", dnsName = ""] = value.split(" ");
      info.tailscale = { state, dnsName };
    } else if (key === "github") info.github = value;
    else if (key === "identity") info.identity = value === "<>" ? null : value;
    else if (key === "repo") info.repos.push(value);
    else if (key === "tmux") info.tmux.push(value);
  }
  return info;
}
