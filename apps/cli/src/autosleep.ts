import { IDLE_CHECK_SCRIPT, parseIdleCheck, type Fleet, type FleetVm } from "@agent-platform/core";
import { forgetHostKey, runScript } from "./ssh";

export type AutosleepEvent =
  | { vm: string; kind: "busy"; reasons: string[] }
  | { vm: string; kind: "idle"; idleMinutes: number; limitMinutes: number }
  | { vm: string; kind: "sleeping" }
  | { vm: string; kind: "slept" }
  | { vm: string; kind: "error"; message: string };

/**
 * Puts VMs to sleep once they've been idle for their limit. Call check()
 * every few minutes. Idle time is counted from the first idle check, so
 * restarting the watcher restarts the clock (it never sleeps a VM early).
 */
export class AutoSleeper {
  private idleSince = new Map<string, number>();
  private running = false;

  constructor(
    private readonly fleet: Fleet,
    private readonly onEvent: (event: AutosleepEvent) => void = () => {},
  ) {}

  /** limits: minutes of idleness by VM name; VMs without one are left alone. */
  async check(vms: FleetVm[], limits: Record<string, number>): Promise<void> {
    // A slow check (or a sleep in progress) shouldn't overlap the next one.
    if (this.running) return;
    this.running = true;
    try {
      await Promise.all(vms.map((vm) => this.checkOne(vm, limits[vm.name])));
    } finally {
      this.running = false;
    }
  }

  private async checkOne(vm: FleetVm, limit: number | undefined): Promise<void> {
    if (!limit || vm.status !== "running" || !vm.publicIp) {
      this.idleSince.delete(vm.name);
      return;
    }
    const { code, stdout, stderr } = await runScript(vm.publicIp, IDLE_CHECK_SCRIPT, { timeoutMs: 30_000 });
    // Can't tell: never sleep a VM we couldn't check.
    if (code !== 0) {
      this.idleSince.delete(vm.name);
      this.onEvent({ vm: vm.name, kind: "error", message: stderr.split("\n").at(-1) || `exit ${code}` });
      return;
    }
    const reasons = parseIdleCheck(stdout);
    if (reasons.length > 0) {
      this.idleSince.delete(vm.name);
      this.onEvent({ vm: vm.name, kind: "busy", reasons });
      return;
    }
    const now = Date.now();
    const since = this.idleSince.get(vm.name) ?? now;
    this.idleSince.set(vm.name, since);
    const idleMinutes = Math.floor((now - since) / 60_000);
    if (idleMinutes < limit) {
      this.onEvent({ vm: vm.name, kind: "idle", idleMinutes, limitMinutes: limit });
      return;
    }
    this.onEvent({ vm: vm.name, kind: "sleeping" });
    try {
      await this.fleet.cloud(vm.provider).vms.sleep(vm);
      forgetHostKey(vm.publicIp);
      this.onEvent({ vm: vm.name, kind: "slept" });
    } catch (err) {
      this.onEvent({ vm: vm.name, kind: "error", message: (err as Error).message });
    } finally {
      this.idleSince.delete(vm.name);
    }
  }
}
