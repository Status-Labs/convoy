import { PROVIDERS } from "./providers";
import type { ProviderDefaults, VmProvider } from "./types";

/** A provider the user has turned on in .env. */
export interface CloudConfig {
  name: string;
  label: string;
  defaults: ProviderDefaults;
  provider: VmProvider;
}

/** A supported provider that isn't turned on, with how to turn it on. */
export interface AvailableCloud {
  name: string;
  label: string;
  setupHint: string;
}

export interface Config {
  /** Used when no provider is chosen explicitly (PROVIDER in .env, else the first enabled). */
  defaultProvider: string;
  clouds: CloudConfig[];
  notEnabled: AvailableCloud[];
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const enabled = PROVIDERS.filter((p) => p.isEnabled(env));
  if (enabled.length === 0) {
    const hints = PROVIDERS.map((p) => `  ${p.label}: ${p.setupHint}`).join("\n");
    throw new Error(`No cloud provider is set up. Copy .env.example to .env and turn one on:\n${hints}`);
  }

  const clouds = enabled.map((p) => ({ name: p.name, label: p.label, ...p.fromEnv(env) }));
  const defaultProvider = env.PROVIDER || clouds[0]!.name;
  if (!clouds.some((c) => c.name === defaultProvider)) {
    const known = PROVIDERS.find((p) => p.name === defaultProvider);
    throw new Error(
      known
        ? `PROVIDER=${defaultProvider}, but ${known.label} isn't set up: ${known.setupHint}.`
        : `Unknown PROVIDER "${defaultProvider}". Expected one of: ${PROVIDERS.map((p) => p.name).join(", ")}.`,
    );
  }

  return {
    defaultProvider,
    clouds,
    notEnabled: PROVIDERS.filter((p) => !p.isEnabled(env)).map(({ name, label, setupHint }) => ({
      name,
      label,
      setupHint,
    })),
  };
}
