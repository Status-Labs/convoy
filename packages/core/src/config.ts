export const PROVIDERS = ["digitalocean", "ovh"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

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

export interface DigitalOceanConfig {
  token: string;
  region: string;
  size: string;
  image: string;
}

export type Config =
  | { provider: "ovh"; ovh: OvhConfig }
  | { provider: "digitalocean"; digitalocean: DigitalOceanConfig };

function requireEnv(env: NodeJS.ProcessEnv, names: string[]): void {
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing environment variables: ${missing.join(", ")}. Copy .env.example to .env and fill it in.`,
    );
  }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const provider = env.PROVIDER || "digitalocean";
  if (!PROVIDERS.includes(provider as ProviderName)) {
    throw new Error(`Unknown PROVIDER "${provider}". Expected one of: ${PROVIDERS.join(", ")}`);
  }

  if (provider === "ovh") {
    requireEnv(env, ["OVH_APPLICATION_KEY", "OVH_APPLICATION_SECRET", "OVH_CONSUMER_KEY", "OVH_PROJECT_ID"]);
    return {
      provider,
      ovh: {
        endpoint: env.OVH_ENDPOINT || "ovh-eu",
        appKey: env.OVH_APPLICATION_KEY!,
        appSecret: env.OVH_APPLICATION_SECRET!,
        consumerKey: env.OVH_CONSUMER_KEY!,
        projectId: env.OVH_PROJECT_ID!,
        region: env.OVH_REGION || "GRA11",
        flavor: env.OVH_FLAVOR || "b3-8",
        image: env.OVH_IMAGE || "Ubuntu 24.04",
      },
    };
  }

  requireEnv(env, ["DIGITALOCEAN_TOKEN"]);
  return {
    provider: "digitalocean",
    digitalocean: {
      token: env.DIGITALOCEAN_TOKEN!,
      region: env.DO_REGION || "nyc1",
      size: env.DO_SIZE || "s-2vcpu-4gb",
      image: env.DO_IMAGE || "ubuntu-24-04-x64",
    },
  };
}

/** The region, size and image new VMs get unless overridden. */
export function providerDefaults(config: Config): { region: string; size: string; image: string } {
  if (config.provider === "ovh") {
    const { region, flavor, image } = config.ovh;
    return { region, size: flavor, image };
  }
  const { region, size, image } = config.digitalocean;
  return { region, size, image };
}
