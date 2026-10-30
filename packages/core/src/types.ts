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

export class ProviderApiError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | string,
    message: string,
  ) {
    super(`${provider} API error ${status}: ${message}`);
  }
}
