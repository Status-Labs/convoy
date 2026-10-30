# Agent Platform: Plan

> Status: v1 plan. Last updated 2026-10-24.
> The long-term concept lives in [docs/archive/VISION.md](docs/archive/VISION.md). Ignore it for now.

## 1. What we're building

A web app where a user signs up, clicks one button, and gets their own **isolated cloud VM** (DigitalOcean, OVHcloud, more later) with AI agent tools already installed. They connect to it and run agents there without risking their own machine.

That's the whole product for v1. We will add features in later iterations.

### Open source + hosted service
- **Open source:** anyone can deploy it themselves against their own OVH project (their API credentials, their bill).
- **Our hosted cloud:** the same software run by us, so people can just sign up instead of deploying. It has extra features on top (e.g. billing, teams, more sizes and regions, managed images).
- **Rule:** the hosted version is the open source core plus add-ons, not a fork. Anything specific to us (billing, our OVH account) stays configuration or a separate module.

### Repository layout
- **Public repo (this one, Apache-2.0):** the full open source product. It must build, run and self-host on its own, with no references to private code.
- **Private company repo:** depends on the public packages and adds:
  - hosted-only features (billing, teams, advanced features)
  - our deployment config and infrastructure
  - anything that touches our OVH account or secrets
- **How they connect:** the core exposes a few **extension points** (interfaces/hooks), and the private repo plugs into them. Examples: auth providers, a "can this user launch a VM?" quota check, VM lifecycle events for billing, extra dashboard pages.
- **Add extension points only when the first hosted feature needs one.** Don't design a plugin system up front.
- **Never fork.** Changes the core needs go into the public repo first; the private repo only adds on top.
- **Day-to-day:** the private repo pulls the public one in as a git submodule (fast while both change often). Later it switches to published npm packages with pinned versions.

## 2. The user flow

1. Sign up / log in.
2. Click **"Launch agent VM"**.
3. Wait about a minute while the status goes `provisioning → booting → ready`.
4. Connect to the VM and run `claude`, `codex`, etc.
5. Stop or delete the VM when done.

Goal: from sign-up to a working agent shell in **under 3 minutes**, with no cloud account or setup on the user's side.

## 3. Architecture

```
 CLI ─────────────────┐
                      ▼
 Browser ──► Web app ──► Core library ──► Cloud provider API (DigitalOcean, OVH)
                   │                        │
                   ▼                        ▼
               Database              User VM (one per user)
          (users, vms, status)       cloud-init installs tools,
                   ▲                 then calls back "ready"
                   └────────────────────────┘
```

Four pieces, nothing more:

- **Core library:** all the VM logic (create, check, stop, delete VM; cloud-init template). Shared by the CLI and the web app so we write it once. Cloud providers plug in behind one small interface (see 4.2).
- **CLI:** built first to prototype against OVH. Stays useful afterwards for self-hosters and admins.
- **Web app:** one deployable (UI and API together). Handles auth, shows the dashboard, calls the core library.
- **Database:** Postgres. Two main tables: `users` and `vms`.
- **OVHcloud:** one OVH Public Cloud project that we own. All user VMs live in it.

## 4. Components

### 4.1 Accounts
- Email + password, or "Sign in with GitHub" (pick one for v1).
- **Invite-only / allowlist** at first, so we control cost before billing exists.

### 4.2 VM provisioning
- **Multiple providers** behind one `VmProvider` interface (create, get, list, delete, list sizes/images), so an outage or account problem at one provider doesn't block us, and self-hosters can pick theirs.
  - Implemented: **DigitalOcean** (default; REST API with a token) and **OVHcloud** (OpenStack-based Public Cloud API).
  - Candidates later: Hetzner Cloud (cheapest), Vultr, Scaleway, AWS.
  - The cloud-init setup script is shared; only the API calls differ per provider.
- Create, check, stop and delete instances through the provider API.
- **Fixed choices for v1:** one region, one flavor (size), one Ubuntu LTS image.
- **Limit: one VM per user.**
- Track state in the `vms` table: `provisioning`, `booting`, `ready`, `stopped`, `error`, `deleted`.
- A small background job polls OVH for state changes and cleans up failed VMs.

### 4.3 Preinstalled tools
- Installed by a **cloud-init script** at first boot. Easy to change while we iterate.
- **User picks tools** at creation: Claude Code, Codex CLI, agent-browser, OpenCode (catalog in `packages/core/src/tools.ts`).
- Always installed: git, Node.js, Python, common build tools, tmux.
- Every VM gets the **security baseline**: upgrades + automatic security updates, hardened SSH, ufw (SSH only), fail2ban, and Docker ports closed unless explicitly exposed (see README).
- The script calls back to our API when finished, which flips the VM to `ready`.
- Later, bake a base image (snapshot) so boot is faster.

### 4.4 Connecting to the VM
- **v1: SSH.** The user pastes their public key once; we inject it via cloud-init and show a copy-paste `ssh` command.
- Later: an in-browser terminal so there is zero setup at all.

### 4.5 Agent credentials
- **v1: we don't touch them.** The user logs in inside the VM (`claude login`, etc.) or sets their own API key. Nothing secret passes through our app.

### 4.6 Isolation and safety
- Each user gets their own VM. No shared private network between user VMs.
- Firewall (security group): inbound SSH only.
- Auto-stop or delete after N hours idle, to cap cost.
- Admin-level cap on total running VMs.

## 5. Out of scope for v1

Billing, teams, multiple VMs per user, VM sizes, region choice, browser terminal, snapshots, our own model gateway, secrets handling, custom tool selection. All candidates for later iterations.

## 6. Build order

### Stage 1: CLI prototype (no web, no database)
An interactive TUI (`pnpm cli`) for day-to-day use, plus plain subcommands for scripting. Detailed VM management and live metrics are planned in [docs/plans/tui-node-management.md](docs/plans/tui-node-management.md). Reads OVH credentials from a config file or env vars. Commands roughly:

```
agent-vm create      # launch a VM with cloud-init, print SSH command when ready
agent-vm list        # show VMs and their status
agent-vm ssh <id>    # connect
agent-vm delete <id>
```

This proves the OVH API, quotas, boot time and the tool install script before we build any UI. Ready = we can go from `create` to running `claude` in a VM reliably.

### Stage 2: web app and backend
1. **Skeleton:** auth, database, empty dashboard.
2. **Launch button:** dashboard calls the same core library the CLI uses; show status.
3. **Ready callback + SSH details:** the user can actually connect.
4. **Stop / delete + idle cleanup job.**
5. **Invite a few users,** watch what breaks, plan iteration 3.

### Stage 3: make it self-hostable
Docs, a sample config and a one-command deploy (e.g. Docker Compose) so others can run it against their own OVH project.

## 7. Decisions to make before building

- [x] **Stack: TypeScript everywhere**, chosen for build speed. One language for the CLI, backend and UI, so the core library is shared directly.
  - Monorepo with pnpm workspaces: `packages/core`, `apps/cli`, `apps/web`
  - Core: the official `ovh` Node client for the OVH API
  - CLI: Node + `commander`
  - Web: Next.js (UI and API routes in one app)
  - Database: Postgres + Drizzle ORM
  - Auth: Better Auth (supports both email/password and GitHub)
  - **Possible later move to Rust** for the core, CLI and backend. The UI stays TypeScript either way. To keep that cheap, the UI talks to the backend only through a plain JSON API, never through Next.js server actions or shared server code.
- [ ] **Auth method:** email/password or GitHub OAuth.
- [ ] **OVH region and flavor** for v1, and the per-VM cost that implies.
- [ ] **Idle policy:** how long before auto-stop, and stop vs. delete.
- [ ] **Hosting** for the web app itself (could also run on OVH).
- [x] **License: Apache-2.0** (see [LICENSE](LICENSE)). Permissive for adoption, with an explicit patent grant. We accept that others could resell it and compete on the hosted features instead. Hosted-only add-ons can stay closed.
- [ ] **Hosted-only features:** which features stay closed or hosted-only vs. go in the open source core.

## 8. Likely next iterations

- In-browser terminal (no SSH key needed)
- Pre-baked images for faster boot
- Choice of VM size and tool presets
- Persistent workspace / snapshots between sessions
- Billing and usage limits
