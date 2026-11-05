// asleep: put to sleep by agent-vm (see VmProvider.sleepVm); costs only storage.
export type VmStatus = "provisioning" | "running" | "stopped" | "asleep" | "error" | "unknown";

export interface Vm {
  id: string;
  name: string;
  status: VmStatus;
  /** The provider's own status string, for debugging. */
  providerStatus: string;
  region: string;
  publicIp: string | null;
  createdAt: string;
  /** The project this VM belongs to, or null. See projects.ts. */
  project: string | null;
  /** List prices for this VM, or null when the provider doesn't say. */
  pricing: VmPricing | null;
  /** Size details, when the provider includes them in its VM listing. */
  spec?: VmSpec;
}

export interface VmSpec {
  size: string;
  vcpus?: number;
  ramGb?: number;
  diskGb?: number;
  /** The image it was created from, e.g. "Ubuntu 24.04 (LTS) x64". */
  image?: string;
}

/** Prices in USD. Used to estimate cost; see cost.ts. */
export interface VmPricing {
  /** Per hour while running, including disk and IP charges. */
  hourly: number;
  /** Per hour while stopped or asleep: DigitalOcean bills stopped droplets in full, AWS only the disk. */
  stoppedHourly: number;
  /** Billing never exceeds this per calendar month (DigitalOcean), or null. */
  monthlyCap: number | null;
}

export interface Region {
  slug: string;
  /** Human-readable name, e.g. "New York 1". */
  name: string;
  /** Sizes that can be created here right now, when the provider says. */
  sizes?: string[];
}

export interface Size {
  name: string;
  vcpus: number;
  ramGb: number;
  diskGb: number;
  /** USD or EUR depending on provider; null when the API doesn't say. */
  priceMonthly: number | null;
}

export interface CreateVmRequest {
  name: string;
  /** Project to tag the VM with. */
  project?: string;
  userData: string;
  region?: string;
  size?: string;
  image?: string;
}

/** What each cloud provider has to implement. Keep it small. */
export interface VmProvider {
  readonly name: string;
  listVms(): Promise<Vm[]>;
  getVm(id: string): Promise<Vm>;
  createVm(request: CreateVmRequest): Promise<Vm>;
  deleteVm(id: string): Promise<void>;
  listRegions(): Promise<Region[]>;
  listSizes(region?: string): Promise<Size[]>;
  listImages(region?: string): Promise<string[]>;

  /**
   * How sleep works on this provider, or undefined if it can't sleep VMs.
   * snapshot: the VM is snapshotted and deleted; waking creates a new VM.
   * stop: the VM is stopped and started again.
   */
  readonly sleepKind?: "snapshot" | "stop";
  /** Puts a running VM to sleep. Reports steps through onStep. */
  sleepVm?(id: string, onStep?: (step: string) => void): Promise<void>;
  /**
   * Wakes an asleep VM and returns it, usually still starting. The id may
   * change (snapshot-based sleep). `userData` is used if a new VM is created.
   */
  wakeVm?(id: string, userData: string): Promise<Vm>;
  /** Cleans up after a woken VM is running (e.g. deletes the sleep snapshot). */
  finishWake?(asleepId: string): Promise<void>;

  /**
   * Snapshots a VM and keeps it. Safe (the default) shuts it down first for a
   * consistent disk and starts it again after; live snapshots it running.
   */
  snapshotVm?(id: string, options: { name: string; live?: boolean; onStep?: (step: string) => void }): Promise<Snapshot>;
  listSnapshots?(): Promise<Snapshot[]>;
  deleteSnapshot?(id: string): Promise<void>;
}

/** A saved copy of a VM's disk that new VMs can be launched from. */
export interface Snapshot {
  id: string;
  name: string;
  /** Name of the VM it was taken from. */
  sourceVm: string | null;
  project: string | null;
  /** Size of the source VM; the default for VMs launched from it. */
  size: string | null;
  regions: string[];
  /** Data stored, in GB (what storage is billed on). */
  sizeGb: number;
  /** Smallest disk a VM launched from it can have. */
  minDiskGb: number;
  createdAt: string;
  /** Storage cost per month, USD, or null when unknown. */
  monthly: number | null;
}

/** The region, size and image new VMs get unless the user picks others. */
export interface ProviderDefaults {
  region: string;
  size: string;
  image: string;
}

/**
 * Everything the app needs to plug in one cloud provider. Adding a provider
 * means writing a VmProvider and one of these, then listing it in
 * providers/index.ts.
 */
export interface ProviderDefinition {
  /** Stable id used in .env (PROVIDER=...), prefs and the CLI's --provider. */
  name: string;
  /** Display name, e.g. "DigitalOcean". */
  label: string;
  /** What to put in .env to turn this provider on. */
  setupHint: string;
  /** Whether the user has turned this provider on in the environment. */
  isEnabled(env: NodeJS.ProcessEnv): boolean;
  /** Builds the provider from the environment; throws if settings are missing. */
  fromEnv(env: NodeJS.ProcessEnv): { provider: VmProvider; defaults: ProviderDefaults };
}

export class ProviderApiError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | string,
    message: string,
  ) {
    super(`${provider} API error ${status}: ${message}`);
  }
}
