// Tailscale puts a VM on the user's private network (tailnet), so their
// phone and laptop can reach it from anywhere without opening any port to
// the internet. Tailscale SSH lets a phone's SSH app sign in with the user's
// Tailscale identity instead of a private key copied to the phone.

/**
 * Root commands that install Tailscale and let tailnet traffic through the
 * firewall. The tailnet only includes the user's own devices; the internet
 * still reaches SSH only.
 */
export const TAILSCALE_INSTALL = [
  "curl -fsSL https://tailscale.com/install.sh | sh",
  "systemctl enable --now tailscaled",
  "ufw allow in on tailscale0 comment 'tailnet'",
].join("\n");

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Bash script, run as the agent user, that joins the VM to the tailnet with
 * an auth key, installing Tailscale first if needed. It contains the key, so
 * pass it on stdin (`bash -s`). The key is only used to join and isn't kept
 * on the VM. Prints the VM's tailnet name.
 */
export function tailscaleJoinScript(authKey: string, hostname: string): string {
  return [
    "set -euo pipefail",
    `if ! command -v tailscale >/dev/null; then sudo bash -c ${shellQuote(TAILSCALE_INSTALL)} >/dev/null; fi`,
    "if [ \"$(tailscale status --json | jq -r .BackendState)\" != Running ]; then",
    "  key=$(sudo mktemp)",
    // Through a root-only file, so the key isn't in any process's arguments.
    `  printf '%s' ${shellQuote(authKey)} | sudo tee "$key" >/dev/null`,
    `  sudo tailscale up --auth-key="file:$key" --hostname=${shellQuote(hostname)} --ssh --timeout=60s || { sudo rm -f "$key"; exit 1; }`,
    '  sudo rm -f "$key"',
    "fi",
    "tailscale status --json | jq -r '.Self.DNSName' | sed 's/\\.$//'",
  ].join("\n") + "\n";
}

/** Signs the VM out of the tailnet. Run before deleting it. */
export const TAILSCALE_LEAVE_SCRIPT = "command -v tailscale >/dev/null || exit 0\nsudo tailscale logout\n";

/** The interactive part of SIGN_IN_SCRIPT for Tailscale: prints a login link. */
export const TAILSCALE_SIGN_IN = `
if command -v tailscale >/dev/null; then
  if [ "$(tailscale status --json 2>/dev/null | jq -r .BackendState)" = Running ]; then
    echo "Tailscale: already connected as $(tailscale status --json | jq -r .Self.DNSName | sed 's/\\.$//')."
  else
    echo; echo "== Tailscale: open the link to add this VM to your tailnet =="
    sudo tailscale up --ssh --hostname "$(hostname)" || echo "Tailscale didn't connect. Retry on the VM with: sudo tailscale up --ssh"
  fi
fi
`;
