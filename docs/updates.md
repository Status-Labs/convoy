# Updating VMs

Convoy keeps improving what it puts on VMs: security fixes to the baseline, a newer Node.js, new agent tools. A VM you launched last month gets those changes without being recreated.

## How you find out

Each VM records the version of Convoy's setup it has (`/etc/convoy/version`). The CLI compares that with its own:

- **TUI:** the VM list shows `↑ update`, or `↑ security` in red. The inspector shows the VM's setup version, and the message line tells you the first time a VM is behind. Versions are read over SSH every 10 minutes while the TUI is open.
- **CLI:** `pnpm cli update` lists every running VM and whether it's up to date. `wake` and `create --snapshot` say so when the VM they bring up is behind.

A VM launched before versions existed shows as setup v0.

## Updating

Press `u` on the VM in the TUI, or:

```sh
pnpm cli update <vm>          # one VM
pnpm cli update --all         # every running VM that's behind
pnpm cli update <vm> --force  # run it even if it's current, to repair a drifted setup
pnpm cli update <vm> --reboot # reboot afterwards if updates need it
```

An update sends this Convoy's setup files to the VM over SSH and runs `converge.sh` as root. That script:

- re-applies the security baseline: the SSH config, firewall (ports you opened with `expose` stay open), fail2ban, automatic security updates, kernel network hardening and the AppArmor profile for agent browsers;
- installs any new base packages, and updates Node.js, `gh`, `glab`, Tailscale and the desktop if the VM has them;
- updates the agent tools picked at launch (`/etc/convoy/tools`).

Agents, tmux sessions and SSH connections keep running. Nothing reboots on its own. If the VM needs a reboot (usually for a kernel update), the TUI and `update` say so, and you choose when with `--reboot`.

The update carries no secrets: API keys and tokens are untouched. Re-apply them with `pnpm cli keys <vm>` as before.

Updating takes a few minutes, mostly reinstalling agent tools. Running it twice in a row is safe.

## Snapshots and sleep

A snapshot keeps the setup version it was taken with. Copies launched from an old snapshot, and VMs woken from sleep, show as behind like any other VM; update them after they start. To stop launching outdated copies, update the original VM and take a new snapshot.

## Your CLI is older than the VM

If a VM was set up or updated by a newer Convoy than the one you're running, `update` refuses rather than downgrading it. Run `git pull` in your Convoy checkout first.

## For contributors

- `vm-setup/converge.sh` must be safe to re-run. CI runs the update twice on a fresh Ubuntu machine and fails if the second run changes anything.
- Any change to what's on a VM (anything in `vm-setup/`, `tools.ts`, the `gh` and `glab` installs) adds an entry to `SETUP_RELEASES` in `vm-updates.ts`, with a one-line note users see. Mark it `security: true` when VMs should update promptly. CI builds the update script from the base branch and from the PR, and fails the PR if they differ without a new entry.
- Re-running can't remove things. To delete a file or rename a folder on existing VMs, add a migration: see `vm-setup/migrations/README.md`.
