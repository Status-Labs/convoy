import {
  ProviderApiError,
  type CreateVmRequest,
  type ProviderDefinition,
  type Region,
  type Size,
  type Snapshot,
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

// Sleeping VMs are snapshots tagged ASLEEP_TAG, plus the droplet's size and
// project, so waking can recreate it. Their VM id is "asleep-<image id>".
const ASLEEP_TAG = "agent-vm-asleep";
const SIZE_TAG = "agent-vm-size:";
const ASLEEP_ID = "asleep-";
// Snapshots the user keeps (not sleep snapshots), plus size and project tags
// like sleep snapshots, and the VM they came from.
const SNAPSHOT_TAG = "agent-vm-snapshot";
const FROM_TAG = "agent-vm-from:";
// Snapshot storage, per GB-month: https://docs.digitalocean.com/products/snapshots/details/pricing/
const SNAPSHOT_GB_MONTH = 0.06;
const HOURS_PER_MONTH = 730;

interface Droplet {
  id: number;
  name: string;
  status: string;
  created_at: string;
  tags: string[];
  region: { slug: string };
  networks: { v4: { ip_address: string; type: string }[] };
  size: { slug: string; price_hourly: number; price_monthly: number };
  vcpus: number;
  memory: number;
  disk: number;
  image: { distribution?: string; name?: string } | null;
}

// A droplet snapshot, from /images.
interface DoSnapshot {
  id: number;
  name: string;
  status: string;
  created_at: string;
  regions: string[];
  size_gigabytes: number;
  min_disk_size: number;
  tags: string[] | null;
}

interface DoAction {
  id: number;
  status: "in-progress" | "completed" | "errored";
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
    spec: {
      size: droplet.size.slug,
      vcpus: droplet.vcpus,
      ramGb: droplet.memory / 1024,
      diskGb: droplet.disk,
      image: droplet.image ? [droplet.image.distribution, droplet.image.name].filter(Boolean).join(" ") : undefined,
    },
  };
}

function asleepToVm(snapshot: DoSnapshot): Vm {
  const tags = snapshot.tags ?? [];
  const hourly = (snapshot.size_gigabytes * SNAPSHOT_GB_MONTH) / HOURS_PER_MONTH;
  return {
    id: ASLEEP_ID + snapshot.id,
    name: snapshot.name,
    status: "asleep",
    providerStatus: "snapshot",
    region: snapshot.regions[0] ?? "",
    publicIp: null,
    createdAt: snapshot.created_at,
    project: tags.find((t) => t.startsWith(PROJECT_TAG))?.slice(PROJECT_TAG.length) ?? null,
    pricing: { hourly, stoppedHourly: hourly, monthlyCap: null },
  };
}

function toSnapshot(image: DoSnapshot): Snapshot {
  const tags = image.tags ?? [];
  const tagged = (prefix: string) => tags.find((t) => t.startsWith(prefix))?.slice(prefix.length) ?? null;
  return {
    id: String(image.id),
    name: image.name,
    sourceVm: tagged(FROM_TAG),
    project: tagged(PROJECT_TAG),
    size: tagged(SIZE_TAG),
    regions: image.regions,
    sizeGb: image.size_gigabytes,
    minDiskGb: image.min_disk_size,
    createdAt: image.created_at,
    monthly: image.size_gigabytes * SNAPSHOT_GB_MONTH,
  };
}

function snapshotId(id: string): string {
  return id.slice(ASLEEP_ID.length);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** DigitalOcean Droplets, via the v2 REST API with a personal access token. */
export class DigitalOceanProvider implements VmProvider {
  readonly name = "digitalocean";
  // Stopped droplets are billed in full, so sleeping means snapshot + delete.
  readonly sleepKind = "snapshot";

  constructor(private readonly config: DigitalOceanConfig) {}

  async listVms(): Promise<Vm[]> {
    const [{ droplets }, { images }] = await Promise.all([
      this.request<{ droplets: Droplet[] }>("GET", `/droplets?tag_name=${TAG}&per_page=200`),
      this.request<{ images: DoSnapshot[] }>("GET", `/images?tag_name=${ASLEEP_TAG}&per_page=200`),
    ]);
    // While waking, the new droplet and its snapshot both exist; show the droplet.
    // Deleted snapshots stay in tag listings for a while, with status "deleted".
    const names = new Set(droplets.map((d) => d.name));
    const asleep = images.filter((i) => i.status === "available" && !names.has(i.name));
    return [...droplets.map(toVm), ...asleep.map(asleepToVm)];
  }

  async getVm(id: string): Promise<Vm> {
    if (id.startsWith(ASLEEP_ID)) return asleepToVm(await this.snapshot(id));
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
      // Snapshot ids are numbers; distribution images are slugs.
      image: /^\d+$/.test(request.image ?? "") ? Number(request.image) : (request.image ?? this.config.image),
      user_data: request.userData,
      tags: request.project ? [TAG, PROJECT_TAG + request.project] : [TAG],
    });
    return toVm(droplet);
  }

  async deleteVm(id: string): Promise<void> {
    if (id.startsWith(ASLEEP_ID)) {
      await this.request("DELETE", `/snapshots/${encodeURIComponent(snapshotId(id))}`);
      return;
    }
    await this.request("DELETE", `/droplets/${encodeURIComponent(id)}`);
  }

  // Shut down → snapshot → tag the snapshot → delete the droplet. If anything
  // fails before the snapshot is safely tagged, the droplet is powered back on
  // and nothing is deleted.
  async sleepVm(id: string, onStep: (step: string) => void = () => {}): Promise<void> {
    const droplet = await this.droplet(id);
    onStep("shutting down");
    await this.powerOff(id);
    try {
      onStep("snapshotting");
      await this.takeSnapshot(droplet, droplet.name, [ASLEEP_TAG]);
    } catch (err) {
      await this.runAction(id, { type: "power_on" }).catch(() => {});
      throw err;
    }
    onStep("deleting the droplet");
    await this.request("DELETE", `/droplets/${encodeURIComponent(id)}`);
  }

  async snapshotVm(
    id: string,
    { name, live = false, onStep = () => {} }: { name: string; live?: boolean; onStep?: (step: string) => void },
  ): Promise<Snapshot> {
    const droplet = await this.droplet(id);
    if (!live) {
      onStep("shutting down");
      await this.powerOff(id);
    }
    try {
      onStep("snapshotting");
      return toSnapshot(await this.takeSnapshot(droplet, name, [SNAPSHOT_TAG, FROM_TAG + droplet.name]));
    } finally {
      if (!live) {
        onStep("starting up");
        await this.runAction(id, { type: "power_on" });
      }
    }
  }

  async listSnapshots(): Promise<Snapshot[]> {
    const { images } = await this.request<{ images: DoSnapshot[] }>("GET", `/images?tag_name=${SNAPSHOT_TAG}&per_page=200`);
    return images.filter((i) => i.status === "available").map(toSnapshot);
  }

  async deleteSnapshot(id: string): Promise<void> {
    await this.request("DELETE", `/snapshots/${encodeURIComponent(id)}`);
  }

  private async droplet(id: string): Promise<Droplet> {
    const { droplet } = await this.request<{ droplet: Droplet }>("GET", `/droplets/${encodeURIComponent(id)}`);
    return droplet;
  }

  // Snapshots the droplet and tags the snapshot with `tags` plus its size and
  // project. If tagging fails, the snapshot is deleted rather than left
  // untagged (invisible to us but billed).
  private async takeSnapshot(droplet: Droplet, name: string, tags: string[]): Promise<DoSnapshot> {
    const allTags = [...tags, SIZE_TAG + droplet.size.slug, ...droplet.tags.filter((t) => t.startsWith(PROJECT_TAG))];
    await this.runAction(String(droplet.id), { type: "snapshot", name }, 2 * 60 * 60_000);
    const snapshot = await this.findNewSnapshot(droplet.id, name);
    try {
      for (const tag of allTags) await this.tagImage(tag, snapshot.id);
    } catch (err) {
      await this.request("DELETE", `/snapshots/${snapshot.id}`).catch(() => {});
      throw err;
    }
    return { ...snapshot, tags: allTags };
  }

  async wakeVm(id: string, userData: string): Promise<Vm> {
    const snapshot = await this.snapshot(id);
    const tags = snapshot.tags ?? [];
    const size = tags.find((t) => t.startsWith(SIZE_TAG))?.slice(SIZE_TAG.length);
    const region = snapshot.regions[0];
    if (!size || !region) throw new Error(`Snapshot ${snapshot.name} is missing its size or region.`);
    await this.assertSizeAvailable(region, size);
    const { droplet } = await this.request<{ droplet: Droplet }>("POST", "/droplets", {
      name: snapshot.name,
      region,
      size,
      image: snapshot.id,
      user_data: userData,
      tags: [TAG, ...tags.filter((t) => t.startsWith(PROJECT_TAG))],
    });
    return toVm(droplet);
  }

  async finishWake(asleepId: string): Promise<void> {
    await this.request("DELETE", `/snapshots/${encodeURIComponent(snapshotId(asleepId))}`);
  }

  private async snapshot(id: string): Promise<DoSnapshot> {
    const { image } = await this.request<{ image: DoSnapshot }>("GET", `/images/${encodeURIComponent(snapshotId(id))}`);
    return image;
  }

  // Graceful shutdown first; force it if the OS hasn't stopped within 2 minutes.
  private async powerOff(id: string): Promise<void> {
    try {
      await this.runAction(id, { type: "shutdown" }, 2 * 60_000);
    } catch {
      await this.runAction(id, { type: "power_off" });
    }
  }

  private async runAction(id: string, action: Record<string, string>, timeoutMs = 10 * 60_000): Promise<void> {
    const { action: started } = await this.request<{ action: DoAction }>(
      "POST",
      `/droplets/${encodeURIComponent(id)}/actions`,
      action,
    );
    const deadline = Date.now() + timeoutMs;
    for (let current = started; ; ) {
      if (current.status === "completed") return;
      if (current.status === "errored") throw new Error(`DigitalOcean ${action.type} failed`);
      if (Date.now() > deadline) throw new Error(`DigitalOcean ${action.type} timed out`);
      // Snapshots take minutes; polling every 10s keeps well inside the rate limit.
      await sleep(10_000);
      ({ action: current } = await this.request<{ action: DoAction }>("GET", `/actions/${current.id}`));
    }
  }

  // A finished snapshot can take a while to show up in the droplet's own
  // snapshot list; the account-wide list usually has it sooner.
  private async findNewSnapshot(dropletId: number, name: string): Promise<DoSnapshot> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const [{ snapshots: own }, { snapshots: all }] = await Promise.all([
        this.request<{ snapshots: DoSnapshot[] }>("GET", `/droplets/${dropletId}/snapshots?per_page=200`),
        this.request<{ snapshots: (DoSnapshot & { resource_id: string; min_disk_size: number })[] }>(
          "GET",
          "/snapshots?resource_type=droplet&per_page=200",
        ),
      ]);
      const match = [...own, ...all.filter((s) => s.resource_id === String(dropletId))]
        .filter((s) => s.name === name)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      // The two endpoints describe snapshots differently; the image API has every field we use.
      if (match) return (await this.request<{ image: DoSnapshot }>("GET", `/images/${match.id}`)).image;
      await sleep(5_000);
    }
    throw new Error(`the snapshot "${name}" finished but didn't show up in your account; check DigitalOcean's Snapshots page`);
  }

  private async tagImage(tag: string, imageId: number): Promise<void> {
    await this.request("POST", "/tags", { name: tag }).catch((err) => {
      // Already exists.
      if (!(err instanceof ProviderApiError && err.status === 422)) throw err;
    });
    await this.request("POST", `/tags/${encodeURIComponent(tag)}/resources`, {
      resources: [{ resource_id: String(imageId), resource_type: "image" }],
    });
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
