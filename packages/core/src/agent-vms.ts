import { randomBytes } from "node:crypto";
import { buildCloudInit } from "./cloud-init";
import { VM_NAME_PREFIX } from "./providers";
import type { ToolId } from "./tools";
import type { Vm, VmProvider } from "./types";

export interface LaunchOptions {
  sshPublicKey: string;
  tools: ToolId[];
  name?: string;
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
      userData: buildCloudInit({ sshPublicKey: options.sshPublicKey, tools: options.tools }),
      region: options.region,
      size: options.size,
      image: options.image,
    });
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
