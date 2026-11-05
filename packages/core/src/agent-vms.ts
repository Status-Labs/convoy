import { randomBytes } from "node:crypto";
import { buildCloudInit, buildRestoreCloudInit, buildWakeCloudInit } from "./cloud-init";
import { VM_NAME_PREFIX } from "./providers";
import type { ToolId } from "./tools";
import type { Snapshot, Vm, VmProvider } from "./types";

export interface LaunchOptions {
  sshPublicKey: string;
  tools: ToolId[];
  tailscale?: boolean;
  desktop?: boolean;
  name?: string;
  project?: string;
  region?: string;
  size?: string;
  image?: string;
}

export function newVmName(): string {
  return `${VM_NAME_PREFIX}${randomBytes(3).toString("hex")}`;
}

/** Provider-independent agent VM operations, used by the CLI and the web app. */
export class AgentVms {
  constructor(readonly provider: VmProvider) {}

  listVms(): Promise<Vm[]> {
    return this.provider.listVms();
  }

  launch(options: LaunchOptions): Promise<Vm> {
    return this.provider.createVm({
      name: options.name ?? newVmName(),
      project: options.project,
      userData: buildCloudInit({ sshPublicKey: options.sshPublicKey, tools: options.tools, tailscale: options.tailscale, desktop: options.desktop }),
      region: options.region,
      size: options.size,
      image: options.image,
    });
  }

  /**
   * Launches a new VM from a snapshot, by default with the snapshot's
   * original size in its region. Its tools, files and sign-ins come from the
   * snapshot; setup only redoes what must differ per machine.
   */
  launchFromSnapshot(
    snapshot: Snapshot,
    options: { sshPublicKey: string; name?: string; project?: string; region?: string; size?: string },
  ): Promise<Vm> {
    const size = options.size ?? snapshot.size;
    const region = options.region ?? snapshot.regions[0];
    if (!size || !region) throw new Error(`Snapshot ${snapshot.name} doesn't say its size or region; pass --size and --region.`);
    if (!snapshot.regions.includes(region)) {
      throw new Error(`Snapshot ${snapshot.name} is only in ${snapshot.regions.join(", ")}.`);
    }
    return this.provider.createVm({
      name: options.name ?? newVmName(),
      project: options.project,
      userData: buildRestoreCloudInit(options.sshPublicKey),
      region,
      size,
      image: snapshot.id,
    });
  }

  /** Snapshots a running VM and keeps it running. */
  async snapshot(vm: Vm, { live = false, onStep }: { live?: boolean; onStep?: (step: string) => void } = {}): Promise<Snapshot> {
    if (!this.provider.snapshotVm) throw new Error(`Snapshots aren't supported on ${this.provider.name} yet.`);
    if (vm.status !== "running") throw new Error(`${vm.name} is ${vm.status}; only running VMs can be snapshotted.`);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
    return this.provider.snapshotVm(vm.id, { name: `${vm.name}-${stamp}`, live, onStep });
  }

  /** Puts a running VM to sleep; see VmProvider.sleepKind. */
  async sleep(vm: Vm, onStep?: (step: string) => void): Promise<void> {
    if (!this.provider.sleepVm) throw new Error(`Sleeping VMs isn't supported on ${this.provider.name} yet.`);
    if (vm.status !== "running") throw new Error(`${vm.name} is ${vm.status}; only running VMs can sleep.`);
    await this.provider.sleepVm(vm.id, onStep);
  }

  /** Wakes an asleep VM and waits until it's running with a public IP. */
  async wake(vm: Vm, sshPublicKey: string): Promise<Vm> {
    if (!this.provider.wakeVm) throw new Error(`Sleeping VMs isn't supported on ${this.provider.name} yet.`);
    if (vm.status !== "asleep") throw new Error(`${vm.name} isn't asleep (${vm.status}).`);
    const woken = await this.provider.wakeVm(vm.id, buildWakeCloudInit(sshPublicKey));
    const running = await this.waitForRunning(woken.id);
    await this.provider.finishWake?.(vm.id);
    return running;
  }

  async findVm(idOrName: string): Promise<Vm> {
    const match = (await this.listVms()).find((vm) => vm.id === idOrName || vm.name === idOrName);
    if (!match) throw new Error(`No agent VM with id or name "${idOrName}"`);
    return match;
  }

  // Polls until the VM is running with a public IPv4 address.
  async waitForRunning(
    id: string,
    { timeoutMs = 10 * 60_000, intervalMs = 5_000, onPoll = (_vm: Vm) => {} } = {},
  ): Promise<Vm> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const vm = await this.provider.getVm(id);
      onPoll(vm);
      if (vm.status === "running" && vm.publicIp) return vm;
      if (vm.status === "error") throw new Error(`VM ${id} failed to start (${vm.providerStatus})`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Timed out waiting for VM ${id} to start`);
  }
}
