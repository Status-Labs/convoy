# Snapshots

A snapshot is a saved copy of a VM's disk. Set a VM up once (tools signed in, repos cloned, config tuned), snapshot it, then launch as many copies as you like. Each copy starts with everything on the snapshot and is ready in about a minute, instead of the 5 or so minutes a fresh setup takes.

Snapshots are DigitalOcean only for now. (Sleeping a VM also uses a snapshot, but that one is deleted when the VM wakes; see the README.)

## Take a snapshot

In the TUI, select a running VM and press `b`, or:

```sh
pnpm cli snapshot <vm>
```

The VM shuts down while its disk is copied, then starts again: a few minutes offline, depending on how much is on the disk. Shutting down first makes sure nothing is half-written. `--live` skips the shutdown, which is faster but can catch files mid-write (a running `npm install`, say).

Snapshots are named `<vm>-<date>-<time>` and remember the VM's size, region and project.

## Launch copies

In the TUI, press `tab` to see your snapshots, select one and press enter. Or:

```sh
pnpm cli create --snapshot <snapshot>                       # same size and region
pnpm cli --project my-app create --snapshot <snapshot> --size s-4vcpu-8gb
```

A copy goes into the current project (in the TUI) or `--project`, else the snapshot's project. It gets the project's repos that aren't already on the disk, your GitHub token and commit identity, and joins your tailnet if the snapshot has Tailscale.

What's different on each copy:
- its own name, IP address and SSH host keys;
- its own Tailscale identity (it joins the tailnet as a new device);
- an empty fail2ban ban list;
- **signed out of Claude and ChatGPT plans.** Subscription logins are never copied between machines (Anthropic doesn't allow tools to pass Claude logins around, and OpenAI asks that one Codex login not be shared). Press `l` on a copy to sign in to your plans. API keys from `.env` stay set up, so API-key VMs work straight away.

What's the same: everything else on the disk, including API keys, the GitHub token, cloned repos, the desktop and its password.

A copy can use a bigger size than the original, but not one with a smaller disk.

## List and delete

```sh
pnpm cli snapshots
pnpm cli snapshot-delete <snapshot>
```

In the TUI's Snapshots view, `d` deletes. Deleting a snapshot doesn't affect VMs launched from it.

## Cost

DigitalOcean charges **$0.06 per GB per month** for the data in the snapshot (not the disk size). A typical agent VM is 3–8 GB, so about $0.20–0.50 a month. The Snapshots view shows each snapshot's cost and the total.

## Security notes

- **A snapshot contains everything on the disk**, including signed-in agent tools, API keys, the GitHub token and the desktop password. Anyone with access to your DigitalOcean account can launch it.
- The snapshot itself still holds any Claude or ChatGPT plan login that was on the VM; copies remove it on first boot, before anything else runs. To keep it off the snapshot entirely, sign out first (`claude auth logout`, `codex logout`).
