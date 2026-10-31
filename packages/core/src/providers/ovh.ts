/// <reference path="./ovh-module.d.ts" />
import ovh from "ovh";
import {
  ProviderApiError,
  type CreateVmRequest,
  type ProviderDefinition,
  type Region,
  type Size,
  type Vm,
  type VmProvider,
  type VmStatus,
} from "../types";
import { requireEnv, VM_NAME_PREFIX } from "./shared";

export interface OvhConfig {
  endpoint: string;
  appKey: string;
  appSecret: string;
  consumerKey: string;
  projectId: string;
  region: string;
  flavor: string;
  image: string;
}

const OVH_CREDENTIALS = ["OVH_APPLICATION_KEY", "OVH_APPLICATION_SECRET", "OVH_CONSUMER_KEY", "OVH_PROJECT_ID"];

export const ovhcloud: ProviderDefinition = {
  name: "ovh",
  label: "OVHcloud",
  setupHint: "set OVH_APPLICATION_KEY, OVH_APPLICATION_SECRET, OVH_CONSUMER_KEY, OVH_PROJECT_ID in .env",
  // Any credential set means the user is turning it on; fromEnv reports the rest.
  isEnabled: (env) => OVH_CREDENTIALS.some((name) => env[name]),
  fromEnv(env) {
    requireEnv(env, "OVHcloud", OVH_CREDENTIALS);
    const config: OvhConfig = {
      endpoint: env.OVH_ENDPOINT || "ovh-eu",
      appKey: env.OVH_APPLICATION_KEY!,
      appSecret: env.OVH_APPLICATION_SECRET!,
      consumerKey: env.OVH_CONSUMER_KEY!,
      projectId: env.OVH_PROJECT_ID!,
      region: env.OVH_REGION || "GRA11",
      flavor: env.OVH_FLAVOR || "b3-8",
      image: env.OVH_IMAGE || "Ubuntu 24.04",
    };
    const { region, flavor, image } = config;
    return { provider: new OvhProvider(config), defaults: { region, size: flavor, image } };
  },
};

interface OvhInstance {
  id: string;
  name: string;
  status: string;
  region: string;
  created: string;
  ipAddresses?: { ip: string; type: string; version: number }[];
}

interface OvhFlavor {
  id: string;
  name: string;
  vcpus: number;
  ram: number;
  disk: number;
  available: boolean;
}

interface OvhImage {
  id: string;
  name: string;
}

const STATUS: Record<string, VmStatus> = {
  BUILD: "provisioning",
  REBOOT: "provisioning",
  ACTIVE: "running",
  SHUTOFF: "stopped",
  ERROR: "error",
};

function toVm(instance: OvhInstance): Vm {
  const publicV4 = instance.ipAddresses?.find((addr) => addr.type === "public" && addr.version === 4);
  return {
    id: instance.id,
    name: instance.name,
    status: STATUS[instance.status] ?? "unknown",
    providerStatus: instance.status,
    region: instance.region,
    publicIp: publicV4?.ip ?? null,
    createdAt: instance.created,
    // OVH prices come from a separate catalog API; not wired up yet.
    pricing: null,
  };
}

/** OVHcloud Public Cloud (OpenStack under the hood), via the signed OVH API. */
export class OvhProvider implements VmProvider {
  readonly name = "ovh";
  private readonly client: ReturnType<typeof ovh>;
  private readonly projectPath: string;

  constructor(private readonly config: OvhConfig) {
    this.client = ovh({
      endpoint: config.endpoint,
      appKey: config.appKey,
      appSecret: config.appSecret,
      consumerKey: config.consumerKey,
    });
    this.projectPath = `/cloud/project/${encodeURIComponent(config.projectId)}`;
  }

  async listVms(): Promise<Vm[]> {
    const instances = await this.request<OvhInstance[]>("GET", "/instance");
    return instances.filter((i) => i.name.startsWith(VM_NAME_PREFIX)).map(toVm);
  }

  async getVm(id: string): Promise<Vm> {
    return toVm(await this.request<OvhInstance>("GET", `/instance/${encodeURIComponent(id)}`));
  }

  async createVm(request: CreateVmRequest): Promise<Vm> {
    const region = request.region ?? this.config.region;
    const [flavorId, imageId] = await Promise.all([
      this.resolveFlavorId(region, request.size ?? this.config.flavor),
      this.resolveImageId(region, request.image ?? this.config.image),
    ]);

    const instance = await this.request<OvhInstance>("POST", "/instance", {
      name: request.name,
      region,
      flavorId,
      imageId,
      userData: request.userData,
      monthlyBilling: false,
    });
    return toVm(instance);
  }

  async deleteVm(id: string): Promise<void> {
    await this.request("DELETE", `/instance/${encodeURIComponent(id)}`);
  }

  async listRegions(): Promise<Region[]> {
    const regions = await this.request<string[]>("GET", "/region");
    return regions.map((slug) => ({ slug, name: slug }));
  }

  async listSizes(region = this.config.region): Promise<Size[]> {
    const flavors = await this.request<OvhFlavor[]>("GET", "/flavor", { region });
    return flavors
      .filter((f) => f.available)
      .map((f) => ({ name: f.name, vcpus: f.vcpus, ramGb: f.ram / 1024, diskGb: f.disk, priceMonthly: null }));
  }

  async listImages(region = this.config.region): Promise<string[]> {
    const images = await this.request<OvhImage[]>("GET", "/image", { region, osType: "linux" });
    return [...new Set(images.map((i) => i.name))];
  }

  private async resolveFlavorId(region: string, name: string): Promise<string> {
    const flavors = await this.request<OvhFlavor[]>("GET", "/flavor", { region });
    const match = flavors.find((f) => f.name === name && f.available);
    if (!match) throw new Error(`Flavor "${name}" is not available in ${region}`);
    return match.id;
  }

  private async resolveImageId(region: string, name: string): Promise<string> {
    const images = await this.request<OvhImage[]>("GET", "/image", { region, osType: "linux" });
    const match = images.find((i) => i.name === name);
    if (!match) throw new Error(`Image "${name}" not found in ${region}`);
    return match.id;
  }

  private async request<T = unknown>(method: string, path: string, params?: Record<string, unknown>): Promise<T> {
    try {
      // The client mutates params, so always pass a copy.
      return await this.client.requestPromised<T>(method, this.projectPath + path, { ...params });
    } catch (err) {
      const { error, message } = err as { error?: number | string; message?: unknown };
      if (error !== undefined) throw new ProviderApiError(this.name, error, String(message ?? "unknown error"));
      throw err;
    }
  }
}
