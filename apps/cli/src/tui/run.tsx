import { render } from "ink";
import { AgentVms, configFromEnv, createProvider, providerDefaults, type Config } from "@agent-platform/core";
import { App, SetupNeeded } from "./app";

export async function runTui(sshKeyPath: string): Promise<void> {
  let config: Config;
  try {
    config = configFromEnv();
  } catch (err) {
    const app = render(<SetupNeeded error={(err as Error).message} />);
    await app.waitUntilExit();
    return;
  }

  const { region, size } = providerDefaults(config);
  const summary = [config.provider, region, size].join(" · ");
  const vms = new AgentVms(createProvider(config));

  const app = render(<App vms={vms} summary={summary} sshKeyPath={sshKeyPath} />, { alternateScreen: true });
  await app.waitUntilExit();
}
