# AGENTS.md

Convoy: launch isolated cloud VMs preloaded with AI agent tools, with one command. Start with `README.md`, then `PLAN.md` for where it's going.

## Company context

This is a Status Labs product. Status Labs team members and agents: before starting, read Weeoh, the company brain, at https://github.com/Status-Labs/weeoh (private; start with its `AGENTS.md`). If it's checked out locally, it's at `../weeoh`. Track your work in Shyup under project `CVY`.

Outside contributors can skip this; everything you need is in this repo.

## Keep it simple

- Smallest change that solves the task. No abstractions until a second real use shows up.
- VM logic lives in `packages/core`, shared by the CLI and the future web app. The CLI only drives it.
- A new cloud is one module in `packages/core/src/providers/`.

## Hard rules

- Never put cloud provider tokens on VMs. VMs get only what they need to work: model API keys, `GITHUB_TOKEN`, Shyup's token.
- Secrets reach VMs over SSH, never through cloud-init / user data (providers keep it).
- Every VM keeps the security baseline in the README: SSH key only, ufw, fail2ban, Docker ports closed.

## Commands

- `pnpm install`, then `pnpm cli` for the TUI or `pnpm cli <command>`.
- `pnpm typecheck` before opening a PR.
