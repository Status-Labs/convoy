# Agent Platform

Launch isolated cloud VMs, preloaded with AI agent tools (Claude Code, Codex CLI), with one command.
Supports DigitalOcean and OVHcloud Public Cloud. See [PLAN.md](PLAN.md) for where this is going.

> Early prototype (Stage 1: CLI). Not ready for use yet.

## Quick start (CLI)

Requires Node.js 22+, pnpm, and a DigitalOcean API token or an OVHcloud Public Cloud project.

```sh
pnpm install
cp .env.example .env   # pick PROVIDER and fill in its credentials

pnpm cli regions       # check credentials, pick a region
pnpm cli sizes         # VM sizes and prices in the default region
pnpm cli create        # launch a VM and wait for tools to install
pnpm cli list
pnpm cli ssh <name>
pnpm cli delete <name>

pnpm cli --provider ovh list   # use another provider for one command
```

## Layout

- `packages/core`: provider-independent VM logic, one module per cloud provider (`src/providers/`), and the VM setup script (cloud-init), shared by the CLI and the future web app
- `apps/cli`: the `agent-vm` CLI

## License

[Apache-2.0](LICENSE)
