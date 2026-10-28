import type { DigitalOceanConfig } from "../config";
import { ProviderApiError, type CreateVmRequest, type Size, type Vm, type VmProvider, type VmStatus } from "../types";

const API = "https://api.digitalocean.com/v2";

// Droplets we manage carry this tag, which the API can filter on.
const TAG = "agent-vm";

interface Droplet {
  id: number;
  name: string;
  status: string;
  created_at: string;
  region: { slug: string };
  networks: { v4: { ip_address: string; type: string }[] };
}

interface DoSize {
  slug: string;
  vcpus: number;
  memory: number;
  disk: number;
  price_monthly: number;
  available: boolean;
  regions: string[];
}

interface DoImage {
  slug: string | null;
  regions: string[];
}

const STATUS: Record<string, VmStatus> = {
  new: "provisioning",
  active: "running",
  off: "stopped",
  archive: "stopped",
};

function toVm(droplet: Droplet): Vm {
  const publicV4 = droplet.networks.v4.find((n) => n.type === "public");
  return {
    id: String(droplet.id),
    name: droplet.name,
    status: STATUS[droplet.status] ?? "unknown",
    providerStatus: droplet.status,
    region: droplet.region.slug,
    publicIp: publicV4?.ip_address ?? null,
    createdAt: droplet.created_at,
  };
}

/** DigitalOcean Droplets, via the v2 REST API with a personal access token. */
export class DigitalOceanProvider implements VmProvider {
  readonly name = "digitalocean";

  constructor(private readonly config: DigitalOceanConfig) {}

  async listVms(): Promise<Vm[]> {
    const { droplets } = await this.request<{ droplets: Droplet[] }>("GET", `/droplets?tag_name=${TAG}&per_page=200`);
    return droplets.map(toVm);
  }

  async getVm(id: string): Promise<Vm> {
    const { droplet } = await this.request<{ droplet: Droplet }>("GET", `/droplets/${encodeURIComponent(id)}`);
    return toVm(droplet);
  }

  async createVm(request: CreateVmRequest): Promise<Vm> {
    const { droplet } = await this.request<{ droplet: Droplet }>("POST", "/droplets", {
      name: request.name,
      region: request.region ?? this.config.region,
      size: request.size ?? this.config.size,
      image: request.image ?? this.config.image,
      user_data: request.userData,
      tags: [TAG],
    });
    return toVm(droplet);
  }

  async deleteVm(id: string): Promise<void> {
    await this.request("DELETE", `/droplets/${encodeURIComponent(id)}`);
  }

  async listRegions(): Promise<string[]> {
    const { regions } = await this.request<{ regions: { slug: string; available: boolean }[] }>(
      "GET",
      "/regions?per_page=200",
    );
    return regions.filter((r) => r.available).map((r) => r.slug);
  }

  async listSizes(region = this.config.region): Promise<Size[]> {
    const { sizes } = await this.request<{ sizes: DoSize[] }>("GET", "/sizes?per_page=200");
    return sizes
      .filter((s) => s.available && s.regions.includes(region))
      .map((s) => ({ name: s.slug, vcpus: s.vcpus, ramGb: s.memory / 1024, diskGb: s.disk, priceMonthly: s.price_monthly }));
  }

  async listImages(region = this.config.region): Promise<string[]> {
    const { images } = await this.request<{ images: DoImage[] }>("GET", "/images?type=distribution&per_page=200");
    return images.filter((i) => i.slug && i.regions.includes(region)).map((i) => i.slug!);
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const error = (await res.json().catch(() => ({}))) as { message?: string };
      throw new ProviderApiError(this.name, res.status, error.message ?? res.statusText);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
}
