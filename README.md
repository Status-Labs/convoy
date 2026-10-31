# Agent Platform

Launch isolated cloud VMs, preloaded with AI agent tools (Claude Code, Codex CLI), with one command.
Supports DigitalOcean, AWS EC2 (untested against a real account yet) and OVHcloud Public Cloud, side by side. See [PLAN.md](PLAN.md) for where this is going.

> Early prototype (Stage 1: CLI). Not ready for use yet.

## Quick start (CLI)

Requires Node.js 22+, pnpm, and an account with at least one provider: a DigitalOcean API token, AWS credentials, or an OVHcloud Public Cloud project.

```sh
pnpm install
cp .env.example .env   # fill in credentials for one or more providers

pnpm cli               # open the interactive TUI
```

In the TUI: `n` launches a VM (pick cloud → region → size → tools; press enter through to reuse your last choices, saved in `~/.config/agent-vm/prefs.json`), `↑/↓` selects, `enter` connects over SSH (exit the shell to come back), `l` signs in the agent tools, `s` puts a VM to sleep and `w` wakes it, `p` switches project, `d` deletes, `q` quits.

**Sleep** a VM you're not using so it costs only storage, and wake it when you need it, with its disk exactly as you left it:
- **DigitalOcean** bills powered-off droplets in full, so sleep shuts the droplet down, snapshots it, and deletes it. Waking creates a new droplet from the snapshot (same name, size, region and project) and deletes the snapshot. A snapshot costs $0.06 per GB of disk in use per month: a VM with ~3 GB in use goes from $24/mo to about $0.16/mo. In testing, sleeping took about 1 minute and waking about 1.5 minutes.
- **AWS** stops the instance: you pay only for its disk (~$3.20/mo for 40 GB) until you start it again.
- Either way the VM gets a new IP when it wakes, and running programs stop. OVHcloud doesn't support sleep yet.

**Projects** group VMs, e.g. one per codebase or client. Press `p` to create or switch projects; new VMs launch into the current one and the list shows only its VMs (or all projects). A VM's project is stored as a tag on the VM at the cloud provider (DigitalOcean tag `agent-vm-project:<name>`, AWS tag `agent-vm-project`), so it's the same from any machine. OVHcloud doesn't support projects yet.

The list shows each VM's hourly rate and its estimated cost so far this month, with totals at the top. Estimates come from list prices and run time: DigitalOcean bills per second (60s minimum, capped at the monthly price), so compute matches the bill; AWS rates come from the AWS Pricing API (needs `pricing:GetProducts`) and include the 40 GB disk and public IPv4 address. Not included: extra bandwidth, snapshots, and AWS burst-credit charges. DigitalOcean bills stopped VMs in full, which the list flags as `stopped, billed`.

**Signing in agent tools.** At launch, choose *Sign in yourself* to use your Claude or ChatGPT plan (press `l` on the VM when it's ready), or *API keys from .env* for swarms: tools are signed in on boot, and you can launch up to 10 VMs at once. See [docs/agent-credentials.md](docs/agent-credentials.md).

The same actions are available as commands for scripting:

```sh
pnpm cli providers     # which clouds are set up
pnpm cli regions       # check credentials, pick a region
pnpm cli sizes         # VM sizes and prices in the default region
pnpm cli create        # launch a VM and wait for tools to install (--api-keys for API-key sign-in)
pnpm cli list          # VMs on every enabled cloud
pnpm cli ssh <name>
pnpm cli login <name>  # sign in agent tools with your own accounts
pnpm cli keys <name>   # re-apply API keys from .env to a VM
pnpm cli delete <name>

pnpm cli --provider aws create   # launch on a non-default cloud
pnpm cli --project my-app create # launch into a project
pnpm cli --project my-app list   # only that project's VMs
pnpm cli projects                # projects and their VM counts
pnpm cli sleep <name>            # stop paying for compute until you wake it
pnpm cli wake <name>
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

More detail, including troubleshooting: [docs/port-forwarding.md](docs/port-forwarding.md).

## Layout

- `packages/core`: provider-independent VM logic, the tool catalog (`src/tools.ts`), the VM setup scripts (`src/vm-setup/`), one module per cloud provider (`src/providers/`; add a provider by writing a `ProviderDefinition` and listing it in `providers/index.ts`), and the VM setup script (cloud-init), shared by the CLI and the future web app
- `apps/cli`: the `agent-vm` TUI and CLI (Ink + commander)

## License

[Apache-2.0](LICENSE)
