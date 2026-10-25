# Agent Platform

Launch isolated cloud VMs, preloaded with AI agent tools (Claude Code, Codex CLI), with one command.
Currently targets OVHcloud Public Cloud. See [PLAN.md](PLAN.md) for where this is going.

> Early prototype (Stage 1: CLI). Not ready for use yet.

## Quick start (CLI)

Requires Node.js 22+, pnpm and an OVHcloud Public Cloud project.

```sh
pnpm install
cp .env.example .env   # fill in OVH credentials and project ID

pnpm cli regions       # check credentials, pick a region
pnpm cli flavors       # VM sizes in OVH_REGION
pnpm cli create        # launch a VM and wait for tools to install
pnpm cli list
pnpm cli ssh <name>
pnpm cli delete <name>
```

## Layout

- `packages/core`: OVH API logic and the VM setup script (cloud-init), shared by the CLI and the future web app
- `apps/cli`: the `agent-vm` CLI

## License

[Apache-2.0](LICENSE)
