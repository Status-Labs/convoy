import type { Config } from "../config";
import type { VmProvider } from "../types";
import { DigitalOceanProvider } from "./digitalocean";
import { OvhProvider } from "./ovh";

export { DigitalOceanProvider, OvhProvider };
export { VM_NAME_PREFIX } from "./shared";

export function createProvider(config: Config): VmProvider {
  switch (config.provider) {
    case "digitalocean":
      return new DigitalOceanProvider(config.digitalocean);
    case "ovh":
      return new OvhProvider(config.ovh);
  }
}
