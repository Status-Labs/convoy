# Linux Desktop on Agent VMs, Viewable from a Phone

> Status: D1–D4 shipped (see [desktop.md](../desktop.md)); D5 (RDP) not started. Phone path (D3) untested with a real tailnet. Last updated 2026-11-05.
> Builds on [phone-access.md](../phone-access.md) (Tailscale), which shipped first: the desktop is reached over the tailnet or an SSH tunnel, never an open port.

## 1. Goal

An opt-in **Desktop** for an agent VM: a lightweight Linux desktop the user can watch and control from a browser, an RDP app, or a phone. The main uses:

- Watch agent-browser or computer-use agents drive a real browser, and step in when they hit a login page, a CAPTCHA or a 2FA prompt.
- Check on agents and their apps from a phone, away from the laptop.
- Use GUI-only tools on the VM.

Keep it simple: one checkbox at launch, one key in the TUI, one command.

## 2. Approach

| Piece | Choice | Why |
|---|---|---|
| Desktop | **XFCE** | Light (about 500 MB of RAM idle), stable, works well at phone and laptop resolutions |
| Remote viewer | **KasmVNC** (recommended) | Built-in web client that works in any browser, including on phones: touch input, clipboard, resizes to the screen. One server covers laptop and phone, with no app to install |
| Also offered | **xrdp** | For people who prefer an RDP app (Windows Remote Desktop, Microsoft's "Windows App" on Mac/iOS/Android). Smoother over slow links. Optional second step, not in D1 |
| Not chosen | noVNC + TigerVNC | Does the same job as KasmVNC with a worse mobile experience |
| Reaching it | **Tailscale** from a phone; **SSH tunnel** from a laptop | No port opened to the internet. The desktop listens on localhost and the tailnet only |

A desktop needs a bigger VM: plan on **4 GB RAM minimum** (`s-2vcpu-4gb`, ~$24/mo on DigitalOcean), more if agents run browsers. The launch form should warn, not block, below 4 GB.

## 3. Milestones

### D1: Desktop option at launch
- [x] A **Desktop** checkbox at the tools step, next to Tailscale (`create --desktop`).
- [x] cloud-init installs XFCE (minimal, `xfce4` + `xfce4-terminal` + `dbus-x11`, no recommended extras) and KasmVNC (the `.deb` for the image's Ubuntu release from KasmVNC's GitHub releases, pinned version, checksum verified).
- [x] KasmVNC runs as the `agent` user under a systemd unit (`agent-vm-desktop`), on display `:1`, listening on `127.0.0.1:8444` only. Phones reach it through `tailscale serve`, not a tailnet listener.
- [x] A random desktop password per VM, generated on the VM at setup, stored mode 600 in `~/.config/agent-vm/desktop-password`. The CLI reads it over SSH to show it; it never goes in cloud-init user data.
- [x] Setup takes a minute or two longer (about 95s in testing). Show "installing desktop" as its own phase in the TUI. (Every setup step now shows in the VM's row, e.g. "adding desktop".)
- [x] Firefox (or Chromium) on the desktop so the user can browse alongside agents. agent-browser's Chromium can also run headed on this display (`DISPLAY=:1`), so the user watches what the agent does.

### D2: Open it from the laptop
- [x] `pnpm cli desktop <vm>`: forwards the desktop port over SSH (like `forward`), prints the URL and password, and opens the browser.
- [x] TUI key `g` (GUI): suspends the TUI, opens the tunnel and the browser, prints the password, and closes the tunnel on enter.

### D3: Open it from the phone
- [x] On VMs with Tailscale and Desktop, `--phone` serves the desktop at `https://<vm-name>.<tailnet>.ts.net` with `tailscale serve` (untested with a real tailnet).
- [x] `pnpm cli desktop <vm> --phone` prints that URL as text and as a **QR code** in the terminal, plus the password, so the phone opens it in one scan.
- [x] HTTPS: `tailscale serve` provides a real certificate for the `*.ts.net` name; the CLI checks that HTTPS certificates are on in the tailnet first and says how to turn them on.
- [ ] Check the phone experience on real devices: touch to click, on-screen keyboard, pinch zoom, readable resolution, clipboard both ways. (A phone-sized headless browser rendered it fine; real devices not tried.)

### D4: Desktop on existing VMs
- [x] `pnpm cli desktop <vm> --install` adds the desktop to a VM launched without it (same script as cloud-init, run over SSH).
- [x] `--uninstall` removes it to free RAM: stops the service, purges KasmVNC, XFCE and Firefox, stops `tailscale serve`.

### D5: Optional RDP
- [ ] xrdp bound to localhost and the tailnet, using the same XFCE session setup.
- [ ] `pnpm cli desktop <vm> --rdp` forwards port 3389 and prints the address for an RDP client. On the phone, the "Windows App" connects to `<vm-name>` over the tailnet.

## 4. Security

- No desktop port is ever opened to the internet. The firewall stays SSH-only from outside; the desktop is reached through the SSH tunnel or the tailnet.
- A password protects the desktop even on the tailnet: a shared tailnet, or a compromised device on it, shouldn't get a free desktop.
- The desktop runs as `agent`, which has passwordless sudo, so desktop access equals full control of the VM. Say so in the docs.
- Agents can read the desktop password file (it's in `agent`'s home). Acceptable, since agents already run as `agent`; note it in the docs.
- Snapshots of a sleeping VM include the desktop password. A woken VM keeps the same password.
- Pin the KasmVNC version and verify its checksum; automatic security updates cover the Ubuntu packages but not the `.deb`, so the update path is a later re-install (D4) or a version bump in agent-vm.

## 5. Testing

- Launch with Desktop + Tailscale on a real DigitalOcean VM:
  - Setup succeeds.
  - KasmVNC listens on 127.0.0.1 and the tailnet only (`ss -tlnp`); the port is closed from the internet (`nc` from outside).
  - Wrong password is refused.
- Laptop: `pnpm cli desktop` opens it; the agent-browser Chromium runs headed and is visible.
- Phone (iOS Safari and Android Chrome): open over the tailnet, sign in, type in a terminal with the on-screen keyboard, copy and paste text both ways, rotate the screen.
- RAM and CPU at idle with the desktop running, on `s-2vcpu-4gb`.
- Sleep and wake: the desktop comes back on the woken VM with the same password.

## 6. Open questions

- Which port, and whether `tailscale serve` should own HTTPS so phones get a valid certificate without a warning.
- Whether the desktop should start at boot or only on demand (`desktop <vm>` starts it). On demand saves RAM on VMs that rarely use it.
- Computer-use agents (Claude's computer use, OpenAI's) could drive this same display. That's a separate plan, but the display setup in D1 should make it easy: one display, `DISPLAY=:1`, at a known resolution.
