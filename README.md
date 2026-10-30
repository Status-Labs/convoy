# Agent Platform

Launch isolated cloud VMs, preloaded with AI agent tools (Claude Code, Codex CLI), with one command.
Supports DigitalOcean and OVHcloud Public Cloud. See [PLAN.md](PLAN.md) for where this is going.

> Early prototype (Stage 1: CLI). Not ready for use yet.

## Quick start (CLI)

Requires Node.js 22+, pnpm, and a DigitalOcean API token or an OVHcloud Public Cloud project.

```sh
pnpm install
cp .env.example .env   # pick PROVIDER and fill in its credentials

pnpm cli               # open the interactive TUI
```

In the TUI: `n` launches a VM, `↑/↓` selects, `enter` connects over SSH (exit the shell to come back), `d` deletes, `q` quits.

The same actions are available as commands for scripting:

```sh
pnpm cli regions       # check credentials, pick a region
pnpm cli sizes         # VM sizes and prices in the default region
pnpm cli create        # launch a VM and wait for tools to install
pnpm cli list
pnpm cli ssh <name>
pnpm cli delete <name>

pnpm cli --provider ovh list   # use another provider for one command
```

## What every VM gets

**Tools (your choice):** Claude Code, Codex CLI, agent-browser (Vercel), OpenCode. The TUI asks when you press `n`; the CLI takes `--tools claude-code,codex` (default: all, or `none`).
Tools are installed for the `agent` user under `~/.local`, so they can update themselves without sudo.

**Security baseline (always):**
- Full package upgrade at first boot, then automatic security updates (`unattended-upgrades`)
- SSH: key-only, `agent` user only, no root login, no passwords, limited auth attempts
- Firewall (`ufw`): all inbound traffic denied except SSH
- `fail2ban` bans IPs that repeatedly fail SSH login
- Basic kernel network hardening (no ICMP redirects or source routing, SYN cookies)
- Base toolchain: git, Node.js 22, Python 3, build tools, ripgrep, jq, tmux

**Docker never exposes ports by accident.** Docker normally bypasses `ufw` when publishing ports. On these VMs:
- Published ports bind to `127.0.0.1` by default (`/etc/docker/daemon.json`), even if Docker is installed later.
- Firewall rules in Docker's `DOCKER-USER` chain drop inbound connections to containers unless the port was explicitly exposed.

To reach a service on the VM, tunnel it over SSH. Nothing is opened to the internet:

```sh
pnpm cli forward <vm> 3000     # http://localhost:3000 -> port 3000 on the VM
```

If you really need a public port, `expose` asks you to type the port number to confirm, after a warning:

```sh
pnpm cli expose <vm> 8080      # opens 8080 in ufw and for Docker
pnpm cli unexpose <vm> 8080
pnpm cli firewall <vm>         # what's open
```

On the VM itself the same thing is `sudo agent-vm-firewall status|expose|unexpose <port>`.

## Layout

- `packages/core`: provider-independent VM logic, the tool catalog (`src/tools.ts`), the VM setup scripts (`src/vm-setup/`), one module per cloud provider (`src/providers/`), and the VM setup script (cloud-init), shared by the CLI and the future web app
- `apps/cli`: the `agent-vm` TUI and CLI (Ink + commander)

## License

[Apache-2.0](LICENSE)
