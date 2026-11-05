import { AgentVms } from "./agent-vms";
import type { Config } from "./config";
import type { ProviderDefaults, Snapshot, Vm } from "./types";

/** One enabled provider and its agent VMs. */
export interface Cloud {
  name: string;
  label: string;
  defaults: ProviderDefaults;
  vms: AgentVms;
}

export interface FleetVm extends Vm {
  provider: string;
}

export interface FleetSnapshot extends Snapshot {
  provider: string;
}

export interface FleetList {
  vms: FleetVm[];
  /** Providers that couldn't be listed; the others still are. */
  errors: { provider: string; message: string }[];
}

/** Agent VMs across every enabled provider. */
export class Fleet {
  readonly clouds: Cloud[];

  constructor(readonly config: Config) {
    this.clouds = config.clouds.map(({ name, label, defaults, provider }) => ({
      name,
      label,
      defaults,
      vms: new AgentVms(provider),
    }));
  }

  cloud(name: string = this.config.defaultProvider): Cloud {
    const cloud = this.clouds.find((c) => c.name === name);
    if (cloud) return cloud;
    const other = this.config.notEnabled.find((c) => c.name === name);
    throw new Error(
      other
        ? `${other.label} isn't set up: ${other.setupHint}.`
        : `Unknown provider "${name}". Enabled: ${this.clouds.map((c) => c.name).join(", ")}.`,
    );
  }

  // One provider failing (outage, bad credentials) doesn't hide the others' VMs.
  async listVms(): Promise<FleetList> {
    const results = await Promise.allSettled(this.clouds.map((c) => c.vms.listVms()));
    const list: FleetList = { vms: [], errors: [] };
    results.forEach((result, i) => {
      const provider = this.clouds[i]!.name;
      if (result.status === "fulfilled") list.vms.push(...result.value.map((vm) => ({ ...vm, provider })));
      else list.errors.push({ provider, message: (result.reason as Error).message });
    });
    return list;
  }

  /** Kept snapshots on every provider that supports them. */
  async listSnapshots(): Promise<{ snapshots: FleetSnapshot[]; errors: { provider: string; message: string }[] }> {
    const clouds = this.clouds.filter((c) => c.vms.provider.listSnapshots);
    const results = await Promise.allSettled(clouds.map((c) => c.vms.provider.listSnapshots!()));
    const list: { snapshots: FleetSnapshot[]; errors: { provider: string; message: string }[] } = { snapshots: [], errors: [] };
    results.forEach((result, i) => {
      const provider = clouds[i]!.name;
      if (result.status === "fulfilled") list.snapshots.push(...result.value.map((s) => ({ ...s, provider })));
      else list.errors.push({ provider, message: (result.reason as Error).message });
    });
    list.snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return list;
  }

  async findSnapshot(idOrName: string): Promise<{ snapshot: FleetSnapshot; cloud: Cloud }> {
    const { snapshots } = await this.listSnapshots();
    const snapshot = snapshots.find((s) => s.id === idOrName || s.name === idOrName);
    if (!snapshot) throw new Error(`No snapshot with id or name "${idOrName}". See: pnpm cli snapshots`);
    return { snapshot, cloud: this.cloud(snapshot.provider) };
  }

  async findVm(idOrName: string): Promise<{ vm: FleetVm; cloud: Cloud }> {
    const { vms, errors } = await this.listVms();
    const vm = vms.find((v) => v.id === idOrName || v.name === idOrName);
    if (!vm) {
      const unreachable = errors.length > 0 ? ` (couldn't check ${errors.map((e) => e.provider).join(", ")})` : "";
      throw new Error(`No agent VM with id or name "${idOrName}"${unreachable}`);
    }
    return { vm, cloud: this.cloud(vm.provider) };
  }
}
