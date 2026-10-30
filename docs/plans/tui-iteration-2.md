# TUI Iteration 2: Regions and Snapshots

> Status: draft for review. Last updated 2026-10-30.
> Follows [tui-node-management.md](tui-node-management.md). This iteration pulls M5 (launch form) forward and adds snapshots. The detail view and metrics (M1–M2) come after.

## 1. Goal

Two things a user can't do today:

1. **Pick where a VM runs.** Choose a region and size when launching, and only see combinations that DigitalOcean can actually create right now. Today a region is set in `.env`, and if it runs out of capacity, launches fail (it happened with `nyc3`).
2. **Save a VM and bring it back.** Take a snapshot of a configured VM (tools logged in, repos cloned, agent config tuned), then launch new VMs from it, or delete the VM to stop paying and restore it later.

Keep it simple: one new form, one new list, a handful of keys.

## 2. What DigitalOcean gives us

| Feature | API | Notes |
|---|---|---|
| Regions + live availability | `GET /v2/regions` | Each region's `sizes` lists what can be created *now*. We already use this. |
| Take a snapshot | `POST /v2/droplets/{id}/actions` `{type: "snapshot", name}` | Returns an action. Takes minutes (scales with used disk). Works on a running droplet, but powering off first gives a consistent disk. |
| Track progress | `GET /v2/actions/{id}` | `in-progress` → `completed` / `errored`. |
| List snapshots | `GET /v2/snapshots?resource_type=droplet` | Gives `id`, `name`, `regions`, `min_disk_size`, `size_gigabytes`, `created_at`. |
| Launch from a snapshot | `POST /v2/droplets` with `image: <snapshot id>` | Numeric ID, not the name. Size's disk must be ≥ `min_disk_size`. Only in regions the snapshot is in. |
| Copy to another region | `POST /v2/images/{id}/actions` `{type: "transfer", region}` | Takes minutes. Each copy is billed. |
| Delete | `DELETE /v2/snapshots/{id}` | |
| Cost | | **$0.06 / GB / month** of snapshot size (used data, not disk size). A typical agent VM is ~5–10 GB ≈ **$0.30–0.60/mo**, vs $24/mo for a running `s-2vcpu-4gb`. |

DigitalOcean also has automatic **Backups** (weekly or daily, priced as a percentage of the droplet's cost). Leave it out for now and revisit when people ask for scheduled protection (§9).

OVH supports instance snapshots too (`POST /cloud/project/{p}/instance/{id}/snapshot`), so this goes in the provider interface, not as DO-only code.

## 3. Milestones

### R1: Regions in the launch flow
- [ ] `n` opens a short launch form instead of jumping to the tool picker:
  1. **Source**: a fresh Ubuntu VM, or one of your snapshots (only shown if you have snapshots, see S3).
  2. **Region**: the regions where the chosen size is available right now, with readable names (`nyc1 New York 1`). The last-used region is preselected.
  3. **Size**: the sizes in that region, with vCPU / RAM / disk / $ per month. Defaults to `s-2vcpu-4gb`.
  4. **Tools**: the current tool picker (fresh VMs only; a snapshot already has its tools).
  5. **Confirm** line: `agent-vm-3fa1 · nyc1 · 2 vCPU 4 GB · $24/mo · claude, codex`. Enter launches.
- [ ] `enter` through every step = launch with the remembered defaults, so the fast path stays one key plus enters.
- [ ] Remember last choices in `~/.config/agent-vm/prefs.json` (region, size, tools). `.env` values become the first-run defaults only.
- [ ] Changing region re-filters sizes. If the remembered size isn't offered there, pick the closest available one and say so.
- [ ] The header shows the current default: `digitalocean · nyc1 · s-2vcpu-4gb`.
- [ ] CLI parity: `create --region` already exists; add `pnpm cli regions --size s-2vcpu-4gb` to show where a size is available.

### S1: Take a snapshot
- [ ] `s` on a VM in the list → confirm panel:
  ```
  Snapshot agent-vm-3fa1?   name: agent-vm-3fa1-2026-10-30
  ( ) Live — VM keeps running, disk may be mid-write
  (•) Safe — shut down, snapshot, start again (VM offline ~2–5 min)
  Storage: ~$0.06/GB/month. enter to start · esc to cancel
  ```
- [ ] **Safe** is the default: graceful shutdown (`shutdown` action, then `power_off` if it doesn't stop within 60s), snapshot, `power_on`, and wait until SSH is back.
- [ ] Progress shows in the VM row: `◐ snapshotting 3m`. Other VMs stay usable.
- [ ] Before a live snapshot, run `sync` over SSH. Don't run `cloud-init clean` (it would make the full setup run again on restore). §4 covers how restore handles per-machine state.

### S2: Snapshots screen
- [ ] `tab` switches between **VMs** and **Snapshots**.
- [ ] Snapshot list: name, source VM, size (GB), regions, created, $/month. The header shows the total snapshot cost.
- [ ] Keys: `enter` launch from it (opens the launch form with the source set), `d` delete (y/N), `c` copy to region (S4), `r` refresh.

### S3: Launch from a snapshot
- [ ] Launch form with source = snapshot: region limited to the snapshot's regions, and sizes limited to `disk ≥ min_disk_size`.
- [ ] Uses a small **restore** cloud-init instead of the full bootstrap (§4). Launch to SSH-ready in ~1 minute instead of ~4–5.
- [ ] Verify after launch: same markers check as today, plus the security baseline still holds (ufw active, sshd config) via a lightweight `agent-vm-doctor` script that ships on every VM.

### S4: Park and copy (stretch)
- [ ] **Park** (`P`): Safe snapshot, then delete the VM after the snapshot completes, with a confirmation that shows the savings (`$24/mo → ~$0.40/mo`). **Restore** = launch from that snapshot with the same name.
- [ ] Copy a snapshot to another region (`c` on the Snapshots screen) via the `transfer` action, with progress.

## 4. Snapshot restore: what has to happen on first boot

A new droplet from a snapshot gets a new instance ID, so cloud-init runs its per-instance steps again. If we passed the full bootstrap, it would upgrade every package and reinstall every tool (slow, and `bootstrap.sh` isn't fully idempotent: it prepends the PATH line to `.bashrc` again).

So launches from a snapshot send a **restore cloud-init** instead:
- The `agent` user and its SSH key already exist on the disk. Still pass the key (the user may be launching with a different key).
- **New SSH host keys**: cloud-init regenerates them per instance by default (`ssh_deletekeys`). Each restored VM has its own identity. The CLI already uses `accept-new` and forgets host keys on delete.
- Security updates only: `apt-get upgrade` limited to the security pocket via `unattended-upgrade` (a one-off run), not a full upgrade.
- Reset per-machine state: fail2ban ban database, `/etc/machine-id` (regenerated by `systemd-firstboot` if cleared at snapshot time; decide in S1).
- Write the `ready` marker again so the CLI's existing setup check works unchanged.

Also make `bootstrap.sh` idempotent anyway (guard the `.bashrc` edit). It's cheap and avoids surprises.

**Secrets warning:** a snapshot contains everything on the disk, including logged-in agent credentials (`~/.claude`, `~/.codex`, API keys in env files). Show this once in the snapshot confirm panel: "Snapshots include any credentials on the VM. Anyone with access to your DigitalOcean account can launch them."

## 5. Provider interface changes

```ts
interface Region { slug: string; name: string; sizes: string[] }       // replaces string[]
interface Snapshot {
  id: string; name: string; sourceVmId: string | null;
  regions: string[]; sizeGb: number; minDiskGb: number; createdAt: string;
}
interface ProviderAction { id: string; status: "in-progress" | "completed" | "errored" }

interface VmProvider {
  listRegions(): Promise<Region[]>;
  // existing: listVms, getVm, createVm, deleteVm, listSizes, listImages
  // createVm's `image` accepts a snapshot id

  listSnapshots(): Promise<Snapshot[]>;
  createSnapshot(vmId: string, name: string): Promise<ProviderAction>;
  deleteSnapshot(id: string): Promise<void>;
  powerOff(vmId: string, graceful: boolean): Promise<ProviderAction>;
  powerOn(vmId: string): Promise<ProviderAction>;
  getAction(id: string): Promise<ProviderAction>;
  transferSnapshot?(id: string, region: string): Promise<ProviderAction>;   // S4, optional
}
```

`core/agent-vms.ts` gains `snapshot(vm, { safe })` (orchestrates shutdown → snapshot → power on → wait), `launchFromSnapshot(...)`, and `buildRestoreCloudInit(...)` in `cloud-init.ts`. The TUI only calls `AgentVms`, so the web app reuses the same flow.

Snapshots are identified by name prefix `agent-vm-` (DO snapshots can't be tagged by the snapshot action itself; tag them afterwards via `POST /v2/tags/agent-vm/resources` if listing by prefix proves too loose).

## 6. Screens

### Launch form
```
 New agent VM                                               esc cancel

 Source   ● Fresh Ubuntu 24.04      ○ agent-vm-3fa1-2026-10-30 (7 GB)
 Region   ❯ nyc1  New York 1
            sfo2  San Francisco 2
            ams3  Amsterdam 3          (9 regions have s-2vcpu-4gb)
 Size     s-2vcpu-4gb   2 vCPU · 4 GB · 80 GB     $24/mo
 Tools    ✓ Claude Code  ✓ Codex  ✓ agent-browser  ✓ OpenCode

 agent-vm-91c2 · nyc1 · 2 vCPU 4 GB · $24/mo          enter launch
```
Up/down moves within a field, tab/enter moves to the next field.

### Snapshots
```
 agent-vm  digitalocean       [VMs]  Snapshots          3 snapshots · $1.10/mo

   NAME                         FROM             SIZE   REGIONS   CREATED
 ❯ agent-vm-3fa1-2026-10-30     agent-vm-3fa1    7 GB   nyc1      2h
   agent-vm-3fa1-2026-10-28     (deleted)        6 GB   nyc1      2d
   golden-claude                agent-vm-77b2    9 GB   nyc1 sfo2 5d

 ⏎ launch  d delete  c copy to region  tab VMs  q quit
```

## 7. API budget

DigitalOcean allows **5,000 requests/hour and 250/minute per token**. On a 429 the provider now backs off (honoring `Retry-After`) and retries up to 3 times.

| Activity | Rate | Per hour |
|---|---|---|
| VM list refresh (TUI open) | 1 every 10s | 360 |
| Snapshot list (Snapshots tab only) | 1 every 30s | 120 |
| Action progress (while a snapshot/power action runs) | 1 every 5s | 720 max, usually a few minutes |
| Regions + sizes (launch form open) | cached 5 min | ~24 |

Comfortably under the limit for one person. Rules to keep it that way:
- Poll only what's on screen; stop polling when the terminal is suspended for SSH.
- Cache regions/sizes for 5 minutes.
- **For the hosted service later:** one DO token shared by all users would hit 5,000/hour fast. Plan per-tenant budgets, a shared cache in the backend, and DigitalOcean webhooks/events instead of polling, or multiple team tokens. Note this in PLAN.md when Stage 2 starts.

## 8. Code changes

```
packages/core/src/
  types.ts              Region, Snapshot, ProviderAction; VmProvider additions (§5)
  providers/digitalocean.ts   regions with names, snapshots, actions, power
  providers/ovh.ts      same, or throw "not supported yet" until needed
  agent-vms.ts          snapshot(), launchFromSnapshot()
  cloud-init.ts         buildRestoreCloudInit()
  vm-setup/bootstrap.sh idempotent .bashrc edit
  vm-setup/doctor.sh    NEW: the baseline audit (from today's manual check), installed on every VM

apps/cli/src/
  prefs.ts              NEW: ~/.config/agent-vm/prefs.json
  tui/app.tsx           tab between VMs and Snapshots
  tui/launch-form.tsx   NEW
  tui/snapshots.tsx     NEW
  index.ts              snapshot / snapshots / restore commands, regions --size
```

## 9. Open questions

- [ ] Safe (shutdown) snapshot as the default, or live? Safe costs a few minutes of downtime but avoids a corrupt-looking disk mid-`npm install`.
- [ ] Should snapshots strip agent credentials by default (log out tools first), or keep them for convenience and only warn? Keeping them is the main point of a "golden" VM.
- [ ] Use snapshots as our **pre-baked images**? We'd maintain a public base snapshot per tool set and skip the fragile first-boot upgrade. DO snapshots can't be shared across accounts, so this works for the hosted service, not for self-hosters (they'd build their own with a `bake` command).
- [ ] Offer DO automatic Backups as a launch option?
- [ ] Retention: auto-delete snapshots older than N days, or keep last N per VM?
