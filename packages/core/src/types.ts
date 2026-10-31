export type VmStatus = "provisioning" | "running" | "stopped" | "error" | "unknown";

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
}

/** Prices in USD. Used to estimate cost; see cost.ts. */
export interface VmPricing {
  /** Per hour while running, including disk and IP charges. */
  hourly: number;
  /** Per hour while stopped: DigitalOcean bills stopped droplets in full, AWS only the disk. */
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
