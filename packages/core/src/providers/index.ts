import type { ProviderDefinition } from "../types";
import { aws } from "./aws";
import { digitalocean } from "./digitalocean";
import { ovhcloud } from "./ovh";

export { AwsProvider } from "./aws";
export { DigitalOceanProvider } from "./digitalocean";
export { OvhProvider } from "./ovh";
export { VM_NAME_PREFIX } from "./shared";

/** Every supported cloud, in the order they're offered. Add new providers here. */
export const PROVIDERS: ProviderDefinition[] = [digitalocean, aws, ovhcloud];
