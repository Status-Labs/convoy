import { render } from "ink";
import { Fleet, configFromEnv } from "@agent-platform/core";
import { loadLaunchPrefs } from "../prefs";
import { App, SetupNeeded } from "./app";

export async function runTui(sshKeyPath: string): Promise<void> {
  let fleet: Fleet;
  try {
    fleet = new Fleet(configFromEnv());
  } catch (err) {
    const app = render(<SetupNeeded error={(err as Error).message} />);
    await app.waitUntilExit();
    return;
  }

  const app = render(<App fleet={fleet} launchPrefs={loadLaunchPrefs(fleet)} sshKeyPath={sshKeyPath} />, {
    alternateScreen: true,
  });
  await app.waitUntilExit();
}
