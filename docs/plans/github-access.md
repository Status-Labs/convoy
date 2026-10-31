# GitHub Access from Agent VMs

> Status: planned, not started. Last updated 2026-10-31.
> Builds on the sign-in modes and `.env` API keys in [agent-credentials.md](../agent-credentials.md) and on projects.

## 1. Goal

Agents on a VM should be able to `git clone`, pull and push the user's GitHub repos, including private ones, with no extra setup per VM.

Public repos already work: every VM has `git`, so `git clone https://github.com/owner/repo` needs no credentials. Private repos and pushing need GitHub credentials on the VM.

## 2. Options considered

| Option | How | Good | Bad |
|---|---|---|---|
| **Fine-grained personal access token** (chosen default) | Created on GitHub, limited to chosen repos with "Contents: read/write". Goes in `.env` as `GITHUB_TOKEN`, installed with `gh auth login --with-token` | You choose exactly which repos it can touch; it expires; fits the existing API-key setup; works for unattended agents | It's a secret on every VM, like the API keys |
| **SSH agent forwarding** (`ssh -A`) | The VM uses the SSH keys on your laptop while you're connected | Nothing stored on the VM | Stops working when you disconnect, so useless for agents running on their own. While connected, anyone with root on the VM can use your keys for *all* your repos |
| **Deploy key per VM** | Generate a key on the VM, add it to one repo | Narrowest access | One repo per key; tedious across many VMs |
| **`gh auth login` on the VM** (offered too) | Device-code sign-in, like the `l` sign-in | Nothing in `.env` | Gives the VM your whole GitHub account by default; done once per VM |
| **GitHub App** (later) | Users install the app on chosen repos; the service mints short-lived tokens | Per-repo access granted on GitHub's own screens, tokens expire in an hour | Needs a server to hold the app key and mint tokens. Right for the hosted web app, not the CLI |

Not doing SSH agent forwarding by default: it doesn't serve unattended agents, and it exposes every repo the user's key can reach.

## 3. Milestones

### G1: `gh` on every VM
- [ ] Install GitHub's CLI (`gh`) in the cloud-init base setup from GitHub's apt repository (signed keyring in `/etc/apt/keyrings`, like Docker's).
- [ ] Not an optional tool in the tools step: it's small and useful for every agent.

### G2: Token from `.env` (API-key mode)
- [ ] `.env.example`: `GITHUB_TOKEN=` with a short note on creating a fine-grained token (repos, Contents read/write, Pull requests read/write if agents should open PRs, an expiry).
- [ ] `AgentKeys` gets `github?: string`; `agentKeysFromEnv` reads `GITHUB_TOKEN`.
- [ ] `keySetupScript` adds, when a token is present:
  - write it to `~/.config/agent-vm/github-token` (mode 600),
  - `gh auth login --with-token < "$keys/github-token"`,
  - `gh auth setup-git`, so plain `git clone`/`push` over https use it and agents need nothing special.
- [ ] Sent over SSH stdin like the other keys, never in cloud-init user data.
- [ ] `pnpm cli keys <vm>` re-applies it (e.g. after rotating the token).
- [ ] The launch form's sign-in step shows GitHub key status (✓ / not set) alongside the Anthropic and OpenAI keys.

Open question: install the token in subscription mode too? Probably yes: GitHub access is separate from the Claude/ChatGPT plan question, and a token isn't a subscription login. Decide when building; at minimum make it a clear choice in the sign-in step.

### G3: Commit identity
- [ ] At launch, read `git config user.name` and `user.email` locally and set them on the VM (`git config --global`), so commits from the VM are attributed to the user.
- [ ] If they aren't set locally, skip and print a hint.
- [ ] Not a secret, but send it in the same SSH step for simplicity.

### G4: Repos per project
- [ ] A project can list repos (`owner/name`). Stored in the CLI prefs file with the project for now; later in the backend.
- [ ] Every VM launched into that project clones them into `~/<name>` once setup and keys are done. Already-present directories are skipped (`git clone` only if missing), so it's safe to re-run.
- [ ] TUI: in the project picker, a key to edit the selected project's repos (one per line).
- [ ] CLI: `pnpm cli projects repos <project> [add|remove] owner/repo`.
- [ ] Clone failures (no access, typo) don't fail the launch: show them on the VM row and in the command output.

### G5: Ad hoc clone
- [ ] `pnpm cli clone <vm> owner/repo [dir]` clones into the VM's home directory.
- [ ] Accepts `owner/repo`, an https URL or a `git@github.com:` URL (rewritten to https so the token works).

### G6: GitHub in "Sign in yourself"
- [ ] `SIGN_IN_SCRIPT` gets a GitHub step: if `gh auth status` fails, run `gh auth login --hostname github.com --git-protocol https --web` (device code), then `gh auth setup-git`.
- [ ] Skip if already signed in (e.g. a token was installed).

## 4. Security notes (put in docs/agent-credentials.md when shipping)

- **Limit the token.** A token with write access lets an agent push. Restrict it to the repos the agents need, give it an expiry, and protect `main` with branch protection so agents push to branches and open PRs.
- Anyone who gets into the VM, including an agent, can read the token. Same as the API keys.
- **Snapshots include it.** A sleeping VM's snapshot contains the token, like the API keys.
- Never put the token in cloud-init user data, command-line arguments or the clone URL (`https://<token>@github.com/...` would end up in `.git/config` and shell history). `gh auth setup-git` keeps it in gh's credential helper.
- Rotating: update `.env`, then `pnpm cli keys <vm>` on each VM (or a future `keys --all`).

## 5. Testing

- Docker Ubuntu 24.04 container: `keySetupScript` with a dummy token (quoting, idempotency, file modes, `gh auth setup-git` wiring; `gh auth login` will reject a dummy token, so stub `gh` or use a real throwaway token).
- Real DigitalOcean VM with a throwaway fine-grained token scoped to one private test repo: clone, commit, push to a branch; confirm push to a protected `main` is refused; confirm the token isn't in user data (`curl 169.254.169.254/metadata/v1/user-data`), `.git/config` or shell history.
- Project repos: launch two VMs into a project with two repos, one of them inaccessible; both VMs come up, the good repo is cloned, the bad one is reported.

## 6. Later

- GitHub App for the hosted service (short-lived per-repo tokens, no PATs in `.env`).
- Per-project tokens (different repos/permissions per project).
- `keys --all` to rotate across the fleet.
