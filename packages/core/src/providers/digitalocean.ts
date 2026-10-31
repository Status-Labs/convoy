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
import { requireEnv } from "./shared";

const API = "https://api.digitalocean.com/v2";

export interface DigitalOceanConfig {
  token: string;
  region: string;
  size: string;
  image: string;
}

export const digitalocean: ProviderDefinition = {
  name: "digitalocean",
  label: "DigitalOcean",
  setupHint: "set DIGITALOCEAN_TOKEN in .env",
  isEnabled: (env) => Boolean(env.DIGITALOCEAN_TOKEN),
  fromEnv(env) {
    requireEnv(env, "DigitalOcean", ["DIGITALOCEAN_TOKEN"]);
    const config: DigitalOceanConfig = {
      token: env.DIGITALOCEAN_TOKEN!,
      region: env.DO_REGION || "nyc1",
      size: env.DO_SIZE || "s-2vcpu-4gb",
      image: env.DO_IMAGE || "ubuntu-24-04-x64",
    };
    const { region, size, image } = config;
    return { provider: new DigitalOceanProvider(config), defaults: { region, size, image } };
  },
};

// Droplets we manage carry this tag, which the API can filter on.
const TAG = "agent-vm";
// Plus `agent-vm-project:<name>` when they belong to a project.
const PROJECT_TAG = "agent-vm-project:";

interface Droplet {
  id: number;
  name: string;
  status: string;
  created_at: string;
  tags: string[];
  region: { slug: string };
  networks: { v4: { ip_address: string; type: string }[] };
  size: { price_hourly: number; price_monthly: number };
}

interface DoSize {
  slug: string;
  vcpus: number;
  memory: number;
  disk: number;
  price_monthly: number;
  available: boolean;
}

interface DoRegion {
  slug: string;
  name: string;
  available: boolean;
  sizes: string[];
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

const MAX_RATE_LIMIT_RETRIES = 3;

// Honors Retry-After when present, else backs off exponentially (2s, 4s, 8s),
// capped at a minute so a long hourly reset surfaces as an error instead.
function retryDelayMs(res: Response, attempt: number): number {
  const retryAfter = Number(res.headers.get("retry-after"));
  const seconds = retryAfter > 0 ? retryAfter : 2 ** (attempt + 1);
  return Math.min(seconds, 60) * 1000;
}

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
    project: droplet.tags.find((t) => t.startsWith(PROJECT_TAG))?.slice(PROJECT_TAG.length) ?? null,
    // Stopped droplets are billed in full; only deleting stops the charge.
    pricing: {
      hourly: droplet.size.price_hourly,
      stoppedHourly: droplet.size.price_hourly,
      monthlyCap: droplet.size.price_monthly,
    },
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
    const region = request.region ?? this.config.region;
    const size = request.size ?? this.config.size;
    await this.assertSizeAvailable(region, size);

    const { droplet } = await this.request<{ droplet: Droplet }>("POST", "/droplets", {
      name: request.name,
      region,
      size,
      image: request.image ?? this.config.image,
      user_data: request.userData,
      tags: request.project ? [TAG, PROJECT_TAG + request.project] : [TAG],
    });
    return toVm(droplet);
  }

  async deleteVm(id: string): Promise<void> {
    await this.request("DELETE", `/droplets/${encodeURIComponent(id)}`);
  }

  async listRegions(): Promise<Region[]> {
    return (await this.regions()).map(({ slug, name, sizes }) => ({ slug, name, sizes }));
  }

  async listSizes(region = this.config.region): Promise<Size[]> {
    const [{ sizes }, regions] = await Promise.all([
      this.request<{ sizes: DoSize[] }>("GET", "/sizes?per_page=200"),
      this.regions(),
    ]);
    const offered = new Set(regions.find((r) => r.slug === region)?.sizes ?? []);
    return sizes
      .filter((s) => s.available && offered.has(s.slug))
      .map((s) => ({ name: s.slug, vcpus: s.vcpus, ramGb: s.memory / 1024, diskGb: s.disk, priceMonthly: s.price_monthly }));
  }

  // A region's `sizes` list is what can actually be created there right now;
  // the per-size `regions` field on /sizes lags behind capacity changes.
  private async regions(): Promise<DoRegion[]> {
    const { regions } = await this.request<{ regions: DoRegion[] }>("GET", "/regions?per_page=200");
    return regions.filter((r) => r.available);
  }

  private async assertSizeAvailable(region: string, size: string): Promise<void> {
    const regions = await this.regions();
    if (regions.find((r) => r.slug === region)?.sizes.includes(size)) return;
    const elsewhere = regions.filter((r) => r.sizes.includes(size)).map((r) => r.slug);
    throw new Error(
      `${size} isn't available in ${region} right now. ` +
        (elsewhere.length > 0
          ? `Available in: ${elsewhere.join(", ")}. Set DO_REGION in .env (or pass --region).`
          : "It isn't available in any region; pick another size with `pnpm cli sizes`."),
    );
  }

  async listImages(region = this.config.region): Promise<string[]> {
    const { images } = await this.request<{ images: DoImage[] }>("GET", "/images?type=distribution&per_page=200");
    return images.filter((i) => i.slug && i.regions.includes(region)).map((i) => i.slug!);
  }

  // DigitalOcean allows 5,000 requests/hour and 250/minute per token. On a 429
  // the request wasn't processed, so it's safe to wait and retry, even a POST.
  private async request<T = unknown>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(res, attempt)));
      return this.request<T>(method, path, body, attempt + 1);
    }
    if (!res.ok) {
      const error = (await res.json().catch(() => ({}))) as { message?: string };
      throw new ProviderApiError(this.name, res.status, error.message ?? res.statusText);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
}
