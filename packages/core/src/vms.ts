/// <reference path="./ovh-module.d.ts" />
import ovh from "ovh";
import { randomBytes } from "node:crypto";
import { buildCloudInit } from "./cloud-init";
import type { Config } from "./config";

// Instances we manage are recognised by this name prefix, since one OVH
// project may also hold unrelated instances.
export const VM_NAME_PREFIX = "agent-vm-";

export interface Vm {
  id: string;
  name: string;
  status: string;
  region: string;
  publicIp: string | null;
  createdAt: string;
}

export interface Flavor {
  id: string;
  name: string;
  region: string;
  vcpus: number;
  ram: number;
  disk: number;
  available: boolean;
}

export interface Image {
  id: string;
  name: string;
  region: string;
}

export interface CreateVmOptions {
  sshPublicKey: string;
  name?: string;
  region?: string;
  flavor?: string;
  image?: string;
}

export class OvhApiError extends Error {
  constructor(
    readonly status: number | string,
    message: string,
  ) {
    super(`OVH API error ${status}: ${message}`);
  }
}

interface OvhInstance {
  id: string;
  name: string;
  status: string;
  region: string;
  created: string;
  ipAddresses?: { ip: string; type: string; version: number }[];
}

function toVm(instance: OvhInstance): Vm {
  const publicV4 = instance.ipAddresses?.find(
    (addr) => addr.type === "public" && addr.version === 4,
  );
  return {
    id: instance.id,
    name: instance.name,
    status: instance.status,
    region: instance.region,
    publicIp: publicV4?.ip ?? null,
    createdAt: instance.created,
  };
}

export class AgentVms {
  private readonly client: ReturnType<typeof ovh>;
  private readonly projectPath: string;

  constructor(private readonly config: Config) {
    this.client = ovh({
      endpoint: config.ovh.endpoint,
      appKey: config.ovh.appKey,
      appSecret: config.ovh.appSecret,
      consumerKey: config.ovh.consumerKey,
    });
    this.projectPath = `/cloud/project/${encodeURIComponent(config.ovh.projectId)}`;
  }

  async listVms(): Promise<Vm[]> {
    const instances = await this.request<OvhInstance[]>("GET", "/instance");
    return instances.filter((i) => i.name.startsWith(VM_NAME_PREFIX)).map(toVm);
  }

  async getVm(id: string): Promise<Vm> {
    return toVm(await this.request<OvhInstance>("GET", `/instance/${encodeURIComponent(id)}`));
  }

  async createVm(options: CreateVmOptions): Promise<Vm> {
    const region = options.region ?? this.config.defaults.region;
    const [flavorId, imageId] = await Promise.all([
      this.resolveFlavorId(region, options.flavor ?? this.config.defaults.flavor),
      this.resolveImageId(region, options.image ?? this.config.defaults.image),
    ]);

    const instance = await this.request<OvhInstance>("POST", "/instance", {
      name: options.name ?? `${VM_NAME_PREFIX}${randomBytes(3).toString("hex")}`,
      region,
      flavorId,
      imageId,
      userData: buildCloudInit({ sshPublicKey: options.sshPublicKey }),
      monthlyBilling: false,
    });
    return toVm(instance);
  }

  async deleteVm(id: string): Promise<void> {
    await this.request("DELETE", `/instance/${encodeURIComponent(id)}`);
  }

  // Polls until the instance is ACTIVE with a public IPv4 address.
  async waitForActive(
    id: string,
    { timeoutMs = 10 * 60_000, intervalMs = 5_000, onPoll = (_vm: Vm) => {} } = {},
  ): Promise<Vm> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const vm = await this.getVm(id);
      onPoll(vm);
      if (vm.status === "ACTIVE" && vm.publicIp) return vm;
      if (vm.status === "ERROR") throw new Error(`VM ${id} failed to start (status ERROR)`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Timed out waiting for VM ${id} to become ACTIVE`);
  }

  async listRegions(): Promise<string[]> {
    return this.request<string[]>("GET", "/region");
  }

  async listFlavors(region = this.config.defaults.region): Promise<Flavor[]> {
    return this.request<Flavor[]>("GET", "/flavor", { region });
  }

  async listImages(region = this.config.defaults.region): Promise<Image[]> {
    return this.request<Image[]>("GET", "/image", { region, osType: "linux" });
  }

  private async resolveFlavorId(region: string, name: string): Promise<string> {
    const flavors = await this.listFlavors(region);
    const match = flavors.find((f) => f.name === name && f.available);
    if (!match) throw new Error(`Flavor "${name}" is not available in ${region}`);
    return match.id;
  }

  private async resolveImageId(region: string, name: string): Promise<string> {
    const images = await this.listImages(region);
    const match = images.find((i) => i.name === name);
    if (!match) throw new Error(`Image "${name}" not found in ${region}`);
    return match.id;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    try {
      // The client mutates params, so always pass a copy.
      return await this.client.requestPromised<T>(method, this.projectPath + path, { ...params });
    } catch (err) {
      const { error, message } = err as { error?: number | string; message?: unknown };
      if (error !== undefined) throw new OvhApiError(error, String(message ?? "unknown error"));
      throw err;
    }
  }
}
