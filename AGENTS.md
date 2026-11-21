# AGENTS.md

Convoy: launch isolated cloud VMs preloaded with AI agent tools, with one command. Start with `README.md`, then `PLAN.md` for where it's going.

## Keep it simple

- Smallest change that solves the task. No abstractions until a second real use shows up.
- VM logic lives in `packages/core`, shared by the CLI and the future web app. The CLI only drives it.
- A new cloud is one module in `packages/core/src/providers/`.

## Hard rules

- Never put cloud provider tokens on VMs. VMs get only what they need to work: model API keys, `GITHUB_TOKEN`, and any service tokens the user adds to `.env`.
- Secrets reach VMs over SSH, never through cloud-init / user data (providers keep it).
- Every VM keeps the security baseline in the README: SSH key only, ufw, fail2ban, Docker ports closed.
- VM setup must be safe to re-run: `convoy update` runs `vm-setup/converge.sh` on existing VMs. Any change to what's on a VM (`vm-setup/`, `tools.ts`, the gh/glab installs) adds a `SETUP_RELEASES` entry in `vm-updates.ts`. Removing or renaming something on existing VMs needs a migration (`vm-setup/migrations/`). CI checks the release entry and that a second run changes nothing. See `docs/updates.md`.

## Commands

- `pnpm install`, then `pnpm cli` for the TUI or `pnpm cli <command>`.
- `pnpm typecheck` before opening a PR.
