# TUI: Detailed VM Management

> Status: M1 and M2 shipped (detail view with live metrics; `i` or `→`), M3 mostly (`t` attaches to tmux), M5 shipped as the launch form. M4, M6 not started. Last updated 2026-11-05.
> Part of Stage 1 in [PLAN.md](../../PLAN.md).

## 1. Goal

Turn the TUI from a VM list into a place where you can **see and manage one VM in detail**: what it is, what it costs, whether setup finished, **live machine metrics**, its agent sessions, and its power state. All without leaving the terminal.

Out of scope here: the web app, multi-user and billing. But anything that isn't UI (provider calls, metrics collection, health checks) goes in `packages/core`, so the web app can reuse it later.

## 2. Where we are

- One screen: VM list (name, status, IP, region, age), auto-refresh every 10s.
- Actions: `n` launch with defaults, `enter` SSH, `d` delete, `r` refresh, `q` quit.
- Setup progress is only known for VMs launched in the current session.

## 3. Milestones

Each milestone is small enough to build, try on a real VM, and adjust.

### M1: Detail view
- [x] `→` / `i` on a VM opens a full-screen detail view; `←` / `esc` goes back. `enter`, `l` and `g` work there too.
- [x] Provider interface returns more per VM: size slug, vCPU, RAM, disk, image, monthly/hourly price.
- [x] **Setup status from the VM itself:** check the `/var/lib/agent-vm/ready` marker over SSH, so status is right even after restarting the TUI. Shows `installing` / `ready` / `failed`.
- [x] Tool versions (claude, codex, agent-browser, opencode, node, python, git, gh), plus GitHub sign-in, commit identity, cloned repos, desktop and tailnet status, tmux sessions.
- [x] Cost columns and totals shipped earlier. The list shows setup steps live for VMs launched in this session; a `SETUP` column for every VM isn't built (the detail view shows it).

### M2: Real-time metrics
- [x] Live CPU, memory, disk, network, load and uptime for the selected VM, updating every 2s (design in §5; per-process CPU from /proc/<pid>/stat deltas rather than `ps`, which reports lifetime averages).
- [x] Sparklines for CPU and memory (last 48 samples ≈ 90s).
- [x] Top processes by CPU (top 5), so you can see what the agent is doing.
- [x] Streaming only while the detail view is open. Closing the view or quitting stops it.

### M3: Agent sessions (tmux)
- [x] `t` connects into a persistent tmux session (`tmux new -A -s agent`). Agents keep running after you disconnect, and `t` reattaches. (`pnpm cli ssh <vm> --tmux`.)
- [ ] Detail view lists the VM's tmux sessions (`tmux ls`); select one to attach. (Listed, not selectable yet.)
- [ ] Decide whether `enter` defaults to tmux or a plain shell (see §8).

### M4: Power controls
- [ ] Provider interface: `powerOn`, `powerOff` (graceful shutdown, then force), `reboot`.
- [ ] `p` toggles power, `b` reboots, each with a confirmation. Status shows transitions (`stopping…`, `starting…`).
- [ ] Show a **billing note**: a stopped VM is still billed on DigitalOcean (and on OVH unless shelved). Only delete stops the cost.

### M5: Launch form (shipped in [tui-iteration-2.md](tui-iteration-2.md) R1)
- [x] `n` opens a form: name, region, size (list with vCPU/RAM/price), image. Defaults prefilled, so `enter` straight through still launches in one step.
- [x] Remember the last choices locally (`~/.config/agent-vm/`).

### M6: Polish
- [ ] `l` setup log: last 200 lines of `/var/log/cloud-init-output.log`, scrollable.
- [ ] `c` copies the SSH command to the clipboard (OSC 52, so it works over SSH too).
- [ ] `/` filters the list by name.
- [ ] `?` shows a help overlay with all keys.
- [ ] Two-pane layout on wide terminals (≥ 120 cols): list on the left, detail on the right.

## 4. Screens

### List (M1 additions)
```
 agent-vm  digitalocean · nyc3 · s-2vcpu-4gb                  2 VMs · $48/mo

   NAME              STATUS        SETUP       IP              CPU   MEM   AGE
 ❯ agent-vm-e41b4e   ● running     ✓ ready     203.0.113.7     12%   31%   3h
   agent-vm-77b2e0   ○ stopped     ✓ ready     203.0.113.9       –     –   2d

 n new  ⏎ connect  → details  d delete  r refresh  ? help  q quit
```
CPU/MEM columns in the list are a stretch goal. They need one metrics stream per running VM (see §5 cost notes).

### Detail (M1–M4)
```
 ← agent-vm-e41b4e                                  ● running · ✓ setup ready
 ──────────────────────────────────────────────────────────────────────────
 Size     s-2vcpu-4gb · 2 vCPU · 4 GB · 80 GB disk          $24/mo ($0.036/h)
 Image    ubuntu-24-04-x64              Region   nyc3
 IP       203.0.113.7                   Created  2026-10-29 14:02 (3h ago)
 Tools    claude 2.1 ✓  codex 0.9 ✓  node 22.11 ✓  python 3.12 ✓

 CPU   12%  ▁▂▂▃▅▇▅▃▂▂▁▁▂▃▂▁▁▁▂▂▃▄▃▂   load 0.42 0.38 0.30   up 3h 12m
 MEM   31%  ▃▃▃▃▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄   1.2 / 3.8 GB      swap 0 / 0
 DISK  8%   6.1 / 78 GB                 r 0 KB/s   w 120 KB/s
 NET        ↓ 14 KB/s   ↑ 3 KB/s

 PROCESSES                CPU    MEM
 node (claude)            9.1%   410 MB
 rg                       2.0%    18 MB
 sshd                     0.1%     8 MB

 SESSIONS  agent (attached) · scratch

 t tmux  s ssh  p power  b reboot  l log  c copy ssh  d delete  ← back
```

## 5. Real-time metrics design

### Options considered

| Option | Latency | Install on VM | Notes |
|---|---|---|---|
| **A. Stream over SSH** ⭐ | ~1–2s | Nothing | One long-lived `ssh` process runs a tiny shell loop that prints `/proc` snapshots. Works on any Linux VM and any provider. |
| B. Provider monitoring API | ~1 min | DO: `do-agent` | Not real-time. Different per provider. Useful later for history and graphs. |
| C. Agent daemon on the VM | ~1s | Yes | Needs an open port or an outbound push target. The right answer for the **web app** later, overkill for the TUI now. |

**Choice: A for the TUI.** Keep the parsing code in `core` and the protocol simple, so C can reuse it later (same collector script, different transport).

### How it works
1. Detail view opens → `core` starts `ssh … sh -c '<collector>'` (no TTY, `BatchMode=yes`).
2. The collector is a POSIX `sh` loop with no dependencies. Every 2s it prints one block of raw sections:
   ```
   @@ <unix-ts>
   @stat     (first lines of /proc/stat: total + per-CPU)
   @mem      (/proc/meminfo: MemTotal, MemAvailable, SwapTotal, SwapFree)
   @load     (/proc/loadavg)
   @uptime   (/proc/uptime)
   @net      (/proc/net/dev, excluding lo)
   @disk     (df -B1 /)
   @diskio   (/proc/diskstats for the root device)
   @ps       (ps -eo comm,pcpu,rss --sort=-pcpu | head -6)
   ```
3. `core/metrics.ts` parses each block and computes **rates from deltas** between blocks (CPU %, net bytes/s, disk IO/s). The VM stays dumb; all the logic lives in TypeScript.
4. It emits a typed `MetricsSample` to a callback. The TUI keeps a ring buffer (60 samples) for sparklines.
5. Leaving the view kills the ssh process. On disconnect it retries with backoff and shows `metrics: reconnecting…`.

### SSH connection reuse
Use OpenSSH multiplexing (`ControlMaster=auto`, `ControlPath=~/.config/agent-vm/cm-%C`, `ControlPersist=60s`). The metrics stream, health check, log viewer and interactive shells then share one TCP/SSH connection per VM, so opening the detail view is near-instant after the first connect.

### Cost and limits
- One metrics stream ≈ one ssh process and a few hundred bytes every 2s. Fine for a handful of VMs.
- CPU/MEM in the **list view** would mean a stream per running VM. Cap it (e.g. visible running VMs only, interval 5s) or skip it until the agent-daemon option (C) exists.
- No metrics for stopped VMs or VMs without an IP yet. Show `–`.

## 6. Code changes

```
packages/core/src/
  types.ts           Vm gains size/image/price fields; VmProvider gains powerOn/powerOff/reboot
  providers/*.ts     map the new fields; implement power actions
                     (DO: POST /droplets/{id}/actions; OVH: /instance/{id}/start|stop|reboot)
  remote.ts          NEW: ssh exec helpers + ControlMaster args (moved from apps/cli/ssh.ts)
  health.ts          NEW: setup status + tool versions via one ssh command
  metrics.ts         NEW: collector script, block parser, rate calculation, stream lifecycle

apps/cli/src/tui/
  app.tsx            becomes a small router: list ↔ detail ↔ form ↔ log
  screens/list.tsx
  screens/detail.tsx
  screens/launch-form.tsx
  screens/log.tsx
  components/        sparkline, key hints, confirm bar, status badge
  hooks/             useVms (list + polling), useMetrics(vm), useHealth(vm)
```

## 7. Keymap

| Key | List | Detail |
|---|---|---|
| `↑/↓`, `j/k` | select | scroll processes / sessions |
| `→`, `i` | open detail | |
| `←`, `esc` | | back |
| `enter` | connect | connect / attach selected session |
| `t` | | tmux session |
| `s` | | plain ssh |
| `n` | launch | |
| `p` / `b` | | power toggle / reboot |
| `d` | delete | delete |
| `l` | | setup log |
| `c` | copy ssh | copy ssh |
| `/` | filter | |
| `r` | refresh | |
| `?` | help | help |
| `q` | quit | quit |

## 8. Open questions

- [ ] Should `enter` connect to a tmux session by default (agents survive disconnects) or a plain shell (less surprising)?
- [ ] Metrics interval: 2s (snappier) vs 5s (lighter)?
- [ ] CPU/MEM columns in the list view now, or wait for the on-VM agent?
- [ ] Should "power off" exist at all, given it doesn't save money on DigitalOcean? Alternative: "snapshot & delete" / "restore from snapshot" (later milestone).
- [ ] Keep metric history beyond the session (e.g. a local SQLite file), or live-only for now?
