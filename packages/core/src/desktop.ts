// The optional Linux desktop on agent VMs (vm-setup/desktop.sh): XFCE with
// KasmVNC's browser client, listening on localhost only. Laptops reach it
// through an SSH tunnel; phones through `tailscale serve`, which gives it a
// real HTTPS certificate on the tailnet and nothing on the internet.

/** KasmVNC's port on the VM (127.0.0.1 only). */
export const DESKTOP_PORT = 8444;

/** The desktop's sign-in user name; the password is per VM. */
export const DESKTOP_USER = "agent";

/** RAM below which the desktop and a browser get cramped. */
export const DESKTOP_MIN_RAM_GB = 4;

/**
 * Prints the desktop password, or exits 3 if the VM has no desktop. Run as
 * the agent user.
 */
export const DESKTOP_INFO_SCRIPT = `
test -f /etc/systemd/system/agent-vm-desktop.service || exit 3
listening() { ss -tln | grep -q "127.0.0.1:${DESKTOP_PORT} "; }
listening || sudo systemctl restart agent-vm-desktop.service
for _ in $(seq 30); do listening && break; sleep 1; done
listening || { echo "the desktop didn't start; see: sudo journalctl -u agent-vm-desktop" >&2; exit 1; }
cat ~/.config/agent-vm/desktop-password
`;

/**
 * Serves the desktop to the tailnet over HTTPS and prints its URL. Exit
 * codes: 3 no desktop, 4 not on a tailnet, 5 HTTPS certificates are off in
 * the tailnet.
 */
export const DESKTOP_PHONE_SCRIPT = `
set -euo pipefail
test -f /etc/systemd/system/agent-vm-desktop.service || exit 3
command -v tailscale >/dev/null || exit 4
status=$(tailscale status --json)
[ "$(jq -r .BackendState <<<"$status")" = Running ] || exit 4
# Empty unless HTTPS is turned on in the tailnet's DNS settings.
[ "$(jq -r '.CertDomains // [] | length' <<<"$status")" -gt 0 ] || exit 5
timeout 60 sudo tailscale serve --bg --https=443 http://127.0.0.1:${DESKTOP_PORT} >/dev/null
echo "https://$(jq -r '.Self.DNSName' <<<"$status" | sed 's/\\.$//')"
`;

/** Stops serving the desktop to the tailnet. */
export const DESKTOP_PHONE_OFF_SCRIPT = "sudo tailscale serve --https=443 off\n";
