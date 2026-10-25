export interface OvhConfig {
  endpoint: string;
  appKey: string;
  appSecret: string;
  consumerKey: string;
  projectId: string;
}

export interface VmDefaults {
  region: string;
  flavor: string;
  image: string;
}

export interface Config {
  ovh: OvhConfig;
  defaults: VmDefaults;
}

const REQUIRED = [
  "OVH_APPLICATION_KEY",
  "OVH_APPLICATION_SECRET",
  "OVH_CONSUMER_KEY",
  "OVH_PROJECT_ID",
] as const;

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing environment variables: ${missing.join(", ")}. Copy .env.example to .env and fill it in.`,
    );
  }

  return {
    ovh: {
      endpoint: env.OVH_ENDPOINT || "ovh-eu",
      appKey: env.OVH_APPLICATION_KEY!,
      appSecret: env.OVH_APPLICATION_SECRET!,
      consumerKey: env.OVH_CONSUMER_KEY!,
      projectId: env.OVH_PROJECT_ID!,
    },
    defaults: {
      region: env.OVH_REGION || "GRA11",
      flavor: env.OVH_FLAVOR || "b3-8",
      image: env.OVH_IMAGE || "Ubuntu 24.04",
    },
  };
}
