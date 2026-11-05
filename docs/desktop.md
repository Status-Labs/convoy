# Linux desktop on a VM

A VM can run a lightweight Linux desktop (XFCE) with Firefox that you open in your browser, on your laptop or your phone. It's useful for watching browser agents work, stepping in when one hits a login page or a CAPTCHA, and using GUI tools.

The desktop listens on the VM's localhost only. You reach it through an SSH tunnel from your laptop, or over your private Tailscale network from your phone. No port is opened to the internet.

## Add a desktop

- **New VM:** tick **Desktop** at the tools step in the TUI, or `pnpm cli create --desktop`. Setup takes a minute or two longer.
- **Existing VM:** `pnpm cli desktop <vm> --install`.
- **Remove it** to free RAM and disk: `pnpm cli desktop <vm> --uninstall` (removes KasmVNC, XFCE and Firefox, and stops serving it to your tailnet).

Pick a size with at least **4 GB of RAM** (`s-2vcpu-4gb` on DigitalOcean). In testing, the desktop with Firefox open used about 1.1 GB, and agent browsers need room on top of that.

## Open it on your laptop

Select the VM in the TUI and press `g`, or run:

```sh
pnpm cli desktop <vm>
```

This opens an SSH tunnel, opens `http://localhost:8444` in your browser and prints the user name (`agent`) and the VM's desktop password. Sign in with those; your browser can save them. Press enter in the TUI (or Ctrl+C on the command line) to close the tunnel.

## Open it on your phone

The VM needs to be on your tailnet (see [phone-access.md](phone-access.md)), and your tailnet needs HTTPS certificates turned on: [DNS settings](https://login.tailscale.com/admin/dns) → **HTTPS Certificates** → Enable. That's a one-time switch.

```sh
pnpm cli desktop <vm> --phone
```

This serves the desktop to your tailnet at `https://<vm-name>.<your-tailnet>.ts.net` with a real certificate, and prints a QR code. With the Tailscale app connected, scan it with your phone's camera, sign in, and use the desktop by touch. KasmVNC's side menu has an on-screen keyboard and clipboard.

It stays served until you stop it (it also survives reboots):

```sh
pnpm cli desktop <vm> --phone-off
```

## What's on the VM

- XFCE, Firefox (from Mozilla's own package repository) and KasmVNC 1.5.2 (pinned, checksum verified).
- KasmVNC runs as the `agent` user on display `:1`, as the `agent-vm-desktop` systemd service, listening on `127.0.0.1:8444`.
- Agents can use the desktop's display: `DISPLAY=:1 firefox`, or a headed agent-browser, and you watch it happen.
- The password is generated on the VM at setup and stored in `~/.config/agent-vm/desktop-password` (mode 600). It never goes into the cloud provider's setup data.

## Security notes

- The desktop runs as `agent`, which has passwordless sudo, so desktop access means full control of the VM.
- Agents on the VM can read the desktop password (it's in `agent`'s home), like the API keys.
- After 5 wrong passwords, KasmVNC refuses sign-ins for a few seconds. Tunnelled connections all come from the VM's localhost, so this briefly locks out every viewer, you included.
- Snapshots of a sleeping VM include the desktop and its password.
- KasmVNC isn't updated by the VM's automatic security updates; agent-vm pins a version, and a newer agent-vm can reinstall it with `desktop <vm> --install`.

## Troubleshooting

- **"has no desktop"**: the VM was launched without one. Add it with `--install`.
- **"Failed to connect to server"** in the page: the desktop service isn't running. `pnpm cli ssh <vm>`, then `sudo systemctl status agent-vm-desktop` and `sudo journalctl -u agent-vm-desktop`.
- **`--phone` says HTTPS is off**: turn on HTTPS Certificates in your tailnet's DNS settings (above).
