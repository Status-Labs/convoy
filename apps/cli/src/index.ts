import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  ALL_TOOL_IDS,
  DESKTOP_USER,
  Fleet,
  PROVIDERS,
  SIGN_IN_SCRIPT,
  agentKeysFromEnv,
  assertProjectName,
  assertKeysFor,
  configFromEnv,
  missingKey,
  formatCost,
  formatRate,
  hourlyRate,
  monthToDateCost,
  DEFAULT_AUTOSLEEP_MINUTES,
  IDLE_CHECK_MS,
  type FleetSnapshot,
  formatMinutes,
  parseIdleMinutes,
  parseRepo,
  parseToolIds,
  repoSlug,
  SETUP_VERSION,
  updateMessage,
  updateStatus,
  type AgentKeys,
  type Cloud,
  type SignInMode,
} from "@convoy/core";
import QRCode from "qrcode";
import { afterSetup } from "./after-setup";
import { AutoSleeper } from "./autosleep";
import { loadAutosleep, loadProjectPrefs, loadProjectRepos, saveAutosleep, saveProjectRepos } from "./prefs";
import {
  checkUpdate,
  cloneRepos,
  desktopPassword,
  forgetHostKey,
  installDesktop,
  openDesktopTunnel,
  openInBrowser,
  serveDesktopToTailnet,
  stopServingDesktop,
  forwardPort,
  installKeys,
  joinTailnet,
  leaveTailnet,
  uninstallDesktop,
  updateVm,
  openShell,
  openTmux,
  runInteractive,
  runRemote,
  sshCommand,
  waitForCloudInit,
} from "./ssh";
import { runTui } from "./tui/run";

const repoRootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
for (const path of [".env", repoRootEnv]) {
  if (existsSync(path)) {
    process.loadEnvFile(path);
    break;
  }
}

let cachedFleet: Fleet | undefined;
function fleet(): Fleet {
  return (cachedFleet ??= new Fleet(configFromEnv()));
}

// Set by --provider; otherwise PROVIDER from .env, else the first enabled one.
let selectedProvider: string | undefined;
// Set by --project: `create` launches into it and `list` shows only it.
let selectedProject: string | undefined;
function cloud(): Cloud {
  return fleet().cloud(selectedProvider);
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? homedir() + path.slice(1) : path;
}

const defaultSshKey = process.env.SSH_PUBLIC_KEY_PATH ?? "~/.ssh/id_ed25519.pub";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

async function confirm(question: string, expected = "y"): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(expected === "y" ? `${question} [y/N] ` : `${question} `);
  rl.close();
  return answer.trim().toLowerCase() === expected;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port "${value}"`);
  return port;
}

async function vmIp(idOrName: string): Promise<{ name: string; ip: string }> {
  const { vm } = await fleet().findVm(idOrName);
  if (!vm.publicIp) throw new Error(`${vm.name} has no public IP yet (status ${vm.status})`);
  return { name: vm.name, ip: vm.publicIp };
}

/** Tells the user if a VM needs a Convoy update. Best effort: never fails the command. */
async function printUpdateHint(name: string, ip: string): Promise<void> {
  try {
    const message = updateMessage(name, updateStatus((await checkUpdate(ip)).version));
    if (message) console.log(`${message} Run: pnpm cli update ${name}`);
  } catch {
    // The VM answered setup checks a moment ago; a hint isn't worth an error.
  }
}

const program = new Command()
  .name("convoy")
  .description("Launch isolated cloud VMs for running AI agent tools")
  .option(
    "-p, --provider <name>",
    `cloud to launch on or list regions/sizes for: ${PROVIDERS.map((p) => p.name).join(", ")} (default: PROVIDER in .env)`,
  )
  .option("--project <name>", "project to launch into, or to list")
  .hook("preAction", (cmd) => {
    selectedProvider = cmd.opts().provider;
    const project = cmd.opts().project;
    selectedProject = project === undefined ? undefined : assertProjectName(project);
  })
  // No command: open the interactive TUI.
  .action(async () => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return program.help();
    await runTui(expandHome(defaultSshKey));
  });

program
  .command("create")
  .description("Launch a new agent VM and wait until it is ready")
  .option("--name <name>", "VM name (default: convoy-<random>)")
  .option("--region <region>", "region (default from .env)")
  .option("--size <size>", "size / flavor name (default from .env)")
  .option("--image <image>", "image name (default from .env)")
  .option("--ssh-key <path>", "public key to install", defaultSshKey)
  .option("--tools <ids>", `comma-separated tools to install, or "none" (default: all: ${ALL_TOOL_IDS.join(",")})`)
  .option("--api-keys", "set up tools with the API keys in .env (default: sign in yourself with `login`)")
  .option("--tailscale", "put the VM on your tailnet for phone access (joins with TAILSCALE_AUTH_KEY, else `login`)")
  .option("--desktop", "install a Linux desktop you open in a browser (`desktop <vm>`); needs 4 GB+ RAM")
  .option("--snapshot <snapshot>", "launch a copy of a snapshot (id or name, see `snapshots`); tools come from it")
  .option("--no-wait", "return as soon as the VM is created")
  .action(async (opts) => {
    const sshPublicKey = readFileSync(expandHome(opts.sshKey), "utf8");
    const keys = agentKeysFromEnv();
    const mode: SignInMode = opts.apiKeys ? "api-keys" : "subscription";
    if (opts.snapshot) return createFromSnapshot(opts, sshPublicKey, keys, mode);
    const tools =
      opts.tools === undefined ? ALL_TOOL_IDS.filter((id) => !missingKey(id, keys, mode))
      : opts.tools === "none" ? []
      : parseToolIds(opts.tools.split(",").map((id: string) => id.trim()).filter(Boolean));
    assertKeysFor(tools, keys, mode);

    const target = cloud();
    const created = await target.vms.launch({
      sshPublicKey,
      tools,
      tailscale: opts.tailscale,
      desktop: opts.desktop,
      project: selectedProject,
      name: opts.name,
      region: opts.region,
      size: opts.size,
      image: opts.image,
    });
    const where = selectedProject ? ` (project ${selectedProject})` : "";
    console.log(`Created ${created.name} (${created.id}) on ${target.label} in ${created.region}${where}`);
    if (!opts.wait) return;

    let lastStatus = "";
    const vm = await target.vms.waitForRunning(created.id, {
      onPoll: ({ providerStatus }) => {
        if (providerStatus !== lastStatus) console.log(`  status: ${providerStatus}`);
        lastStatus = providerStatus;
      },
    });
    console.log(`  public IP: ${vm.publicIp}`);

    let lastPhase = "";
    await waitForCloudInit(vm.publicIp!, {
      onPhase: (phase) => {
        if (phase !== lastPhase) console.log(`  ${phase}...`);
        lastPhase = phase;
      },
    });
    const repos = loadProjectRepos(selectedProject ?? null);
    const { tailnetName, cloned, problems } = await afterSetup(vm.publicIp!, {
      name: vm.name,
      mode,
      keys,
      tailscale: Boolean(opts.tailscale),
      repos,
    });
    if (mode === "api-keys" && (keys.anthropic || keys.openai)) console.log("  agent tools set up with your API keys");
    if (keys.github) console.log("  git signed in to GitHub with GITHUB_TOKEN");
    for (const c of cloned.filter((c) => c.status !== "fail")) console.log(`  cloned ${c.repo}${c.status === "skip" ? " (already there)" : ""}`);
    for (const problem of problems) console.warn(`  ✗ ${problem}`);
    console.log(`Ready. Connect with:\n  pnpm cli ssh ${vm.name}\n  ${sshCommand(vm.publicIp!)}`);
    if (tailnetName) console.log(`From your phone (Tailscale app + an SSH app):\n  ssh agent@${tailnetName}`);
    if (opts.desktop) console.log(`Open the desktop with:\n  pnpm cli desktop ${vm.name}${tailnetName ? ` (add --phone for your phone)` : ""}`);
    if (mode === "subscription" || (opts.tailscale && !keys.tailscale)) {
      console.log(`Sign in ${opts.tailscale && !keys.tailscale ? "agent tools and Tailscale" : "agent tools"} with:\n  pnpm cli login ${vm.name}`);
    }
  });

async function createFromSnapshot(
  opts: { snapshot: string; name?: string; region?: string; size?: string; wait: boolean },
  sshPublicKey: string,
  keys: AgentKeys,
  mode: SignInMode,
): Promise<void> {
  const { snapshot, cloud: target } = await fleet().findSnapshot(opts.snapshot);
  const project = selectedProject ?? snapshot.project ?? undefined;
  const created = await target.vms.launchFromSnapshot(snapshot, {
    sshPublicKey,
    name: opts.name,
    project,
    region: opts.region,
    size: opts.size,
  });
  console.log(`Created ${created.name} from ${snapshot.name} on ${target.label} in ${created.region}${project ? ` (project ${project})` : ""}`);
  if (!opts.wait) return;
  const vm = await target.vms.waitForRunning(created.id);
  forgetHostKey(vm.publicIp!);
  console.log(`  public IP: ${vm.publicIp}`);
  await waitForCloudInit(vm.publicIp!);
  const { tailnetName, cloned, problems } = await afterSetup(vm.publicIp!, {
    name: vm.name,
    mode,
    keys,
    tailscale: "if-installed",
    repos: loadProjectRepos(project ?? null),
  });
  for (const c of cloned.filter((c) => c.status === "ok")) console.log(`  cloned ${c.repo}`);
  for (const problem of problems) console.warn(`  ✗ ${problem}`);
  console.log(`Ready. Connect with:\n  pnpm cli ssh ${vm.name}`);
  if (tailnetName) console.log(`From your phone: ssh agent@${tailnetName}`);
  await printUpdateHint(vm.name, vm.publicIp!);
}

program
  .command("list")
  .description("List agent VMs")
  .action(async () => {
    const { vms: all, errors } = await fleet().listVms();
    for (const { provider, message } of errors) console.error(`Couldn't list ${provider} VMs: ${message}`);
    const vms = selectedProject ? all.filter((vm) => vm.project === selectedProject) : all;
    if (vms.length === 0) return console.log(selectedProject ? `No agent VMs in ${selectedProject}.` : "No agent VMs.");
    console.table(
      vms.map((vm) => {
        const rate = hourlyRate(vm);
        const cost = monthToDateCost(vm);
        return {
          name: vm.name,
          project: vm.project ?? "",
          provider: vm.provider,
          id: vm.id,
          status: vm.status,
          region: vm.region,
          publicIp: vm.publicIp,
          "$/hr": rate === null ? "" : formatRate(rate),
          "this month (est.)": cost === null ? "" : formatCost(cost),
          createdAt: vm.createdAt,
        };
      }),
    );
  });

program
  .command("ssh <vm>")
  .description("Open a shell on an agent VM (id or name)")
  .option("-t, --tmux", "attach to the VM's persistent tmux session (programs keep running when you disconnect)")
  .action(async (idOrName: string, opts) => {
    const { vm } = await fleet().findVm(idOrName);
    if (!vm.publicIp) throw new Error(`${vm.name} has no public IP yet (status ${vm.status})`);
    process.exitCode = opts.tmux ? await openTmux(vm.publicIp) : await openShell(vm.publicIp);
  });

program
  .command("login <vm>")
  .description("Sign in Claude Code and Codex on the VM with your own accounts")
  .action(async (idOrName: string) => {
    const { ip } = await vmIp(idOrName);
    process.exitCode = await runInteractive(ip, SIGN_IN_SCRIPT);
  });

program
  .command("keys <vm>")
  .description("Set up the VM with the API keys and GITHUB_TOKEN in .env (e.g. after changing a key)")
  .action(async (idOrName: string) => {
    const { name, ip } = await vmIp(idOrName);
    const keys = agentKeysFromEnv();
    await installKeys(ip, keys);
    const done = [
      keys.anthropic || keys.openai ? "agent tools use the API keys from .env" : null,
      keys.github
        ? "git uses GITHUB_TOKEN; commits are by its account's GitHub noreply address"
        : "no GITHUB_TOKEN in .env, so the VM has no commit identity and git won't commit",
    ];
    console.log(`On ${name}: ${done.filter(Boolean).join("; ")}.`);
  });

program
  .command("clone <vm> <repo> [dir]")
  .description("Clone a GitHub repo (owner/repo or URL) into the VM's home directory")
  .action(async (idOrName: string, repo: string, dir: string | undefined) => {
    const { name, ip } = await vmIp(idOrName);
    const [result] = await cloneRepos(ip, [{ repo: parseRepo(repo), dir }]);
    if (result?.status === "ok") return console.log(`Cloned ${result.repo} into ~/${dir ?? parseRepo(repo).name} on ${name}.`);
    if (result?.status === "skip") return console.log(`~/${dir ?? parseRepo(repo).name} already exists on ${name}; left it alone.`);
    const hint = agentKeysFromEnv().github
      ? "Check that GITHUB_TOKEN can read it."
      : `For private repos, add GITHUB_TOKEN to .env and run: pnpm cli keys ${name}`;
    throw new Error(`couldn't clone ${result?.repo ?? repo}: ${result?.reason ?? "unknown error"}. ${hint}`);
  });

program
  .command("repos <project> [action] [repo]")
  .description("List a project's repos, or add/remove one: repos <project> add owner/repo. New VMs in the project clone them")
  .action((project: string, action: string | undefined, repo: string | undefined) => {
    assertProjectName(project);
    const repos = loadProjectRepos(project);
    if (action === undefined) {
      if (repos.length === 0) return console.log(`${project} has no repos. Add one with: pnpm cli repos ${project} add owner/repo`);
      return repos.forEach((r) => console.log(r));
    }
    if (action !== "add" && action !== "remove") throw new Error(`Unknown action "${action}": use add or remove.`);
    if (!repo) throw new Error(`Which repo? pnpm cli repos ${project} ${action} owner/repo`);
    const slug = repoSlug(parseRepo(repo));
    if (action === "add") {
      if (repos.includes(slug)) return console.log(`${slug} is already in ${project}.`);
      saveProjectRepos(project, [...repos, slug]);
      return console.log(`Added ${slug} to ${project}. VMs launched into ${project} will clone it; for existing ones: pnpm cli clone <vm> ${slug}`);
    }
    if (!repos.includes(slug)) throw new Error(`${slug} isn't in ${project}.`);
    saveProjectRepos(project, repos.filter((r) => r !== slug));
    console.log(`Removed ${slug} from ${project}. Existing clones on VMs are left alone.`);
  });

program
  .command("tailscale <vm>")
  .description("Put a VM on your tailnet with TAILSCALE_AUTH_KEY from .env, installing Tailscale if needed")
  .action(async (idOrName: string) => {
    const { name, ip } = await vmIp(idOrName);
    const authKey = agentKeysFromEnv().tailscale;
    if (!authKey) {
      throw new Error(`No TAILSCALE_AUTH_KEY in .env (see .env.example). Or sign in on the VM: pnpm cli ssh ${name}, then sudo tailscale up --ssh`);
    }
    const tailnetName = await joinTailnet(ip, authKey, name);
    console.log(`${name} is on your tailnet. From your phone (Tailscale app + an SSH app):\n  ssh agent@${tailnetName}`);
  });

program
  .command("desktop <vm>")
  .description("Open the VM's Linux desktop in your browser, over an SSH tunnel")
  .option("--install", "add the desktop to a VM launched without it (takes a few minutes)")
  .option("--uninstall", "remove the desktop to free RAM and disk")
  .option("--phone", "serve the desktop to your tailnet over HTTPS and show a QR code to open it on your phone")
  .option("--phone-off", "stop serving the desktop to your tailnet")
  .option("--no-open", "don't open the browser, just print the address")
  .action(async (idOrName: string, opts) => {
    const { name, ip } = await vmIp(idOrName);
    if (opts.uninstall) {
      console.log(`Removing the desktop from ${name}...`);
      await uninstallDesktop(ip);
      return console.log(`Removed. Add it back with: pnpm cli desktop ${name} --install`);
    }
    if (opts.install) {
      console.log(`Installing the desktop on ${name}...`);
      const code = await installDesktop(ip);
      if (code !== 0) throw new Error(`desktop install failed (exit ${code})`);
    }
    if (opts.phoneOff) {
      await stopServingDesktop(ip);
      return console.log(`${name}'s desktop is no longer served to your tailnet.`);
    }
    const password = await desktopPassword(ip);
    if (!password) throw new Error(`${name} has no desktop. Add one with: pnpm cli desktop ${name} --install`);
    const login = `  user: ${DESKTOP_USER}\n  password: ${password}`;

    if (opts.phone) {
      const url = await serveDesktopToTailnet(ip);
      console.log(await QRCode.toString(url, { type: "terminal", small: true }));
      console.log(`On your phone (Tailscale app connected), scan the code or open:\n  ${url}\n${login}`);
      console.log(`Only devices on your tailnet can open it. Stop with: pnpm cli desktop ${name} --phone-off`);
      return;
    }

    const tunnel = await openDesktopTunnel(ip);
    console.log(`${name}'s desktop is at ${tunnel.url}\n${login}\nPress Ctrl+C to close the tunnel.`);
    if (opts.open) openInBrowser(tunnel.url);
    process.once("SIGINT", () => tunnel.close());
    await tunnel.closed;
  });

program
  .command("update [vm]")
  .description(
    "Bring a VM's Convoy setup (security baseline, CLIs, agent tools) up to date in place. No VM: show which VMs need it",
  )
  .option("--all", "update every running VM that needs it")
  .option("--force", "run the update even if the VM is up to date (repairs a drifted setup)")
  .option("--reboot", "reboot afterwards if updates need it (stops running programs)")
  .action(async (idOrName: string | undefined, opts) => {
    if (idOrName) return void (await updateOne(idOrName, opts));
    const { vms: all, errors } = await fleet().listVms();
    for (const { provider, message } of errors) console.error(`Couldn't list ${provider} VMs: ${message}`);
    const vms = all.filter((vm) => vm.status === "running" && vm.publicIp && (!selectedProject || vm.project === selectedProject));
    if (vms.length === 0) return console.log("No running VMs.");
    const checked = await Promise.all(
      vms.map(async (vm) => {
        try {
          const { version, rebootRequired } = await checkUpdate(vm.publicIp!);
          return { vm, status: updateStatus(version), rebootRequired, error: null };
        } catch (err) {
          return { vm, status: null, rebootRequired: false, error: (err as Error).message };
        }
      }),
    );
    const label = { current: "up to date", available: "update available", security: "SECURITY UPDATE", newer: "newer than this CLI" };
    for (const { vm, status, rebootRequired, error } of checked) {
      const state = status ? `v${status.version} ${label[status.state]}` : `couldn't check: ${error}`;
      console.log(`${vm.name.padEnd(28)} ${state}${rebootRequired ? " · reboot pending" : ""}`);
    }
    const outdated = checked.filter((c) => c.status?.state === "available" || c.status?.state === "security");
    if (outdated.length === 0) return console.log(`All checked VMs are on setup v${SETUP_VERSION} or newer.`);
    const notes = [...new Set(outdated.flatMap((c) => c.status!.notes))];
    console.log(`\nWhat's new:\n${notes.map((n) => `  - ${n}`).join("\n")}`);
    if (!opts.all) return console.log(`\nUpdate one with: pnpm cli update <vm>, or all with: pnpm cli update --all`);
    let failed = 0;
    for (const { vm } of outdated) {
      console.log(`\n== ${vm.name}`);
      if (!(await updateOne(vm.name, opts))) failed++;
    }
    if (failed > 0) {
      console.error(`\n${plural(failed, "update")} failed.`);
      process.exitCode = 1;
    }
  });

async function updateOne(idOrName: string, opts: { force?: boolean; reboot?: boolean }): Promise<boolean> {
  const { name, ip } = await vmIp(idOrName);
  const before = await checkUpdate(ip);
  const status = updateStatus(before.version);
  if (status.state === "newer") throw new Error(updateMessage(name, status)!);
  if (status.state === "current" && !opts.force) {
    console.log(`${name} is up to date (setup v${status.version}).`);
  } else {
    console.log(`Updating ${name} from setup v${status.version} to v${SETUP_VERSION}. Agents and SSH sessions keep running.`);
    for (const note of status.notes) console.log(`  - ${note}`);
    const code = await updateVm(ip);
    if (code !== 0) {
      console.error(`Update failed on ${name} (exit ${code}). It's safe to run again: pnpm cli update ${name} --force`);
      process.exitCode = 1;
      return false;
    }
    console.log(`${name} is on setup v${SETUP_VERSION}.`);
  }
  const { rebootRequired } = await checkUpdate(ip);
  if (!rebootRequired) return true;
  if (!opts.reboot) {
    console.log(`${name} needs a reboot to finish installing updates. When nothing's running: pnpm cli update ${name} --reboot`);
    return true;
  }
  console.log(`Rebooting ${name}...`);
  await runRemote(ip, "sudo systemctl reboot");
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  await waitForCloudInit(ip);
  console.log(`${name} is back.`);
  return true;
}

program
  .command("sleep <vm>")
  .description("Put a VM to sleep so it costs only storage (DigitalOcean: snapshot + delete; AWS: stop)")
  .option("-y, --yes", "skip confirmation")
  .action(async (idOrName: string, opts) => {
    const { vm, cloud } = await fleet().findVm(idOrName);
    const kind = cloud.vms.provider.sleepKind;
    if (kind === "snapshot") {
      console.warn(
        `${vm.name} will be shut down, snapshotted and deleted until you wake it. Running programs stop, ` +
          "and the snapshot includes everything on the disk, including signed-in credentials.",
      );
    }
    if (!opts.yes && !(await confirm(`Put ${vm.name} to sleep?`))) return console.log("Cancelled.");
    await cloud.vms.sleep(vm, (step) => console.log(`  ${step}...`));
    if (vm.publicIp) forgetHostKey(vm.publicIp);
    console.log(`${vm.name} is asleep. Wake it with: pnpm cli wake ${vm.name}`);
  });

program
  .command("wake <vm>")
  .description("Wake a sleeping VM and wait until it's ready (it gets a new IP)")
  .option("--ssh-key <path>", "public key to install", defaultSshKey)
  .action(async (idOrName: string, opts) => {
    const { vm, cloud } = await fleet().findVm(idOrName);
    console.log(`Waking ${vm.name}...`);
    const woken = await cloud.vms.wake(vm, readFileSync(expandHome(opts.sshKey), "utf8"));
    forgetHostKey(woken.publicIp!);
    console.log(`  public IP: ${woken.publicIp}`);
    await waitForCloudInit(woken.publicIp!);
    console.log(`Ready. Connect with: pnpm cli ssh ${vm.name}`);
    await printUpdateHint(vm.name, woken.publicIp!);
  });

program
  .command("autosleep [vm] [after]")
  .description(
    `Put a VM to sleep after it's idle for a while (e.g. autosleep <vm> 30m; default ${DEFAULT_AUTOSLEEP_MINUTES}m; "off" to stop). ` +
      "Only while the TUI or `autosleep watch` is running. No VM: list settings",
  )
  .action(async (vmArg: string | undefined, after: string | undefined) => {
    if (vmArg === undefined) {
      const settings = Object.entries(loadAutosleep());
      if (settings.length === 0) return console.log(`No VMs auto-sleep. Turn it on with: pnpm cli autosleep <vm> ${DEFAULT_AUTOSLEEP_MINUTES}m`);
      for (const [name, minutes] of settings) console.log(`${name.padEnd(24)} after ${formatMinutes(minutes)} idle`);
      return;
    }
    if (vmArg === "watch") return watchAutosleep();
    const { vm, cloud } = await fleet().findVm(vmArg);
    const minutes = after === undefined ? DEFAULT_AUTOSLEEP_MINUTES : parseIdleMinutes(after);
    if (minutes !== null && !cloud.vms.provider.sleepKind) throw new Error(`Sleep isn't supported on ${cloud.label} yet.`);
    saveAutosleep(vm.name, minutes);
    if (minutes === null) return console.log(`${vm.name} won't auto-sleep.`);
    console.log(
      `${vm.name} sleeps after ${formatMinutes(minutes)} idle: no SSH session, desktop viewer, agent tool, ` +
        "program in tmux or busy CPU. This runs while the TUI is open, or keep `pnpm cli autosleep watch` running.",
    );
  });

async function watchAutosleep(): Promise<void> {
  const sleeper = new AutoSleeper(fleet(), (event) => {
    const time = new Date().toLocaleTimeString();
    switch (event.kind) {
      case "busy":
        return console.log(`${time} ${event.vm}: busy (${event.reasons.join(", ")})`);
      case "idle":
        return console.log(`${time} ${event.vm}: idle ${event.idleMinutes}m of ${event.limitMinutes}m`);
      case "sleeping":
        return console.log(`${time} ${event.vm}: idle long enough, putting it to sleep`);
      case "slept":
        return console.log(`${time} ${event.vm}: asleep. Wake it with: pnpm cli wake ${event.vm}`);
      case "error":
        return console.warn(`${time} ${event.vm}: ${event.message}`);
    }
  });
  console.log(`Watching for idle VMs every ${IDLE_CHECK_MS / 60_000} minutes. Press Ctrl+C to stop.`);
  for (;;) {
    const limits = loadAutosleep();
    if (Object.keys(limits).length === 0) console.log("No VMs have auto-sleep on (pnpm cli autosleep <vm> 30m).");
    else await sleeper.check((await fleet().listVms()).vms, limits);
    await new Promise((resolve) => setTimeout(resolve, IDLE_CHECK_MS));
  }
}

program
  .command("snapshot <vm>")
  .description("Save a copy of a VM's disk to launch new VMs from (create --snapshot); the VM keeps running")
  .option("--live", "don't shut the VM down first (faster, but files being written may be inconsistent)")
  .option("-y, --yes", "skip confirmation")
  .action(async (idOrName: string, opts) => {
    const { vm, cloud } = await fleet().findVm(idOrName);
    console.warn(
      (opts.live ? "" : `${vm.name} will be shut down for a few minutes while its disk is copied, then started again. `) +
        "The snapshot includes everything on the disk, including signed-in credentials and API keys; " +
        "anyone with access to your cloud account can launch it. Storage is about $0.06/GB/month.",
    );
    if (!opts.yes && !(await confirm(`Snapshot ${vm.name}?`))) return console.log("Cancelled.");
    const snapshot = await cloud.vms.snapshot(vm, { live: opts.live, onStep: (step) => console.log(`  ${step}...`) });
    if (!opts.live && vm.publicIp) {
      console.log("  waiting for it to come back...");
      await waitForCloudInit(vm.publicIp);
    }
    console.log(`Saved ${snapshot.name} (${snapshot.sizeGb} GB). Launch a copy with:\n  pnpm cli create --snapshot ${snapshot.name}`);
  });

program
  .command("snapshots")
  .description("List saved snapshots")
  .action(async () => {
    const { snapshots, errors } = await fleet().listSnapshots();
    for (const { provider, message } of errors) console.error(`Couldn't list ${provider} snapshots: ${message}`);
    const shown = selectedProject ? snapshots.filter((s) => s.project === selectedProject || s.untagged) : snapshots;
    if (shown.length === 0) return console.log("No snapshots. Take one with: pnpm cli snapshot <vm>");
    console.table(
      shown.map((s) => ({
        name: s.name,
        from: s.untagged ? "(untagged)" : (s.sourceVm ?? ""),
        project: s.project ?? "",
        provider: s.provider,
        size: s.size ?? "",
        "data (GB)": s.sizeGb,
        regions: s.regions.join(" "),
        "$/mo": s.monthly === null ? "" : formatCost(s.monthly),
        created: s.createdAt,
      })),
    );
  });

program
  .command("snapshot-delete <snapshot>")
  .description("Delete a saved snapshot (id or name)")
  .option("-y, --yes", "skip confirmation")
  .action(async (idOrName: string, opts) => {
    const { snapshot, cloud } = await fleet().findSnapshot(idOrName);
    if (!opts.yes && !(await confirm(`Delete snapshot ${snapshot.name}?`))) return console.log("Cancelled.");
    await cloud.vms.provider.deleteSnapshot!(snapshot.id);
    console.log(`Deleted ${snapshot.name}.`);
  });

program
  .command("delete <vm>")
  .description("Delete an agent VM (id or name) and the snapshots taken from it")
  .option("-y, --yes", "skip confirmation")
  .option("--keep-snapshots", "delete only the VM, keeping snapshots taken from it")
  .action(async (idOrName: string, opts) => {
    const { vm, cloud } = await fleet().findVm(idOrName);
    let snapshots: FleetSnapshot[] = [];
    if (!opts.keepSnapshots) {
      try {
        snapshots = await fleet().snapshotsOf(vm);
      } catch (err) {
        // Not being able to list snapshots shouldn't keep a billed VM around.
        console.warn(`Couldn't check for ${vm.name}'s snapshots (${(err as Error).message}); deleting only the VM.`);
      }
    }
    if (snapshots.length > 0) {
      console.log(`Its snapshots go too:`);
      for (const s of snapshots) console.log(`  ${s.name} (${s.sizeGb} GB${s.monthly === null ? "" : `, ${formatCost(s.monthly)}/mo`})`);
    }
    if (!opts.yes && !(await confirm(`Delete ${vm.name} (${vm.id}) on ${cloud.label}${snapshots.length > 0 ? ` and ${plural(snapshots.length, "snapshot")}` : ""}?`))) return;
    if (vm.status === "running" && vm.publicIp) await leaveTailnet(vm.publicIp);
    await cloud.vms.provider.deleteVm(vm.id);
    if (vm.publicIp) forgetHostKey(vm.publicIp);
    const failed = await fleet().deleteSnapshots(snapshots);
    for (const { snapshot, message } of failed) console.error(`Couldn't delete snapshot ${snapshot.name}: ${message}`);
    const gone = snapshots.length - failed.length;
    console.log(`Deleted ${vm.name}${gone > 0 ? ` and ${plural(gone, "snapshot")}` : ""}`);
    if (failed.length > 0) process.exitCode = 1;
  });

program
  .command("forward <vm> <port> [localPort]")
  .description("Reach a port on the VM at localhost over SSH, without opening it to the internet")
  .action(async (idOrName: string, port: string, localPort: string | undefined) => {
    const { name, ip } = await vmIp(idOrName);
    const remote = parsePort(port);
    const local = localPort ? parsePort(localPort) : remote;
    console.log(`Forwarding http://localhost:${local} -> ${name}:${remote}. Press Ctrl+C to stop.`);
    process.exitCode = await forwardPort(ip, local, remote);
  });

program
  .command("expose <vm> <port>")
  .description("Open a TCP port on the VM to the whole internet (prefer `forward`)")
  .option("-y, --yes", "skip confirmation")
  .action(async (idOrName: string, port: string, opts) => {
    const { name, ip } = await vmIp(idOrName);
    const p = parsePort(port);
    console.warn(
      [
        `WARNING: this makes port ${p} on ${name} (${ip}) reachable by anyone on the internet.`,
        "Automated scanners find open ports within minutes. Only expose services that require",
        "authentication, and close the port again with `convoy unexpose` when done.",
        `If you only need to reach it yourself, use instead:  pnpm cli forward ${name} ${p}`,
        "",
      ].join("\n"),
    );
    if (!opts.yes && !(await confirm(`Type the port number (${p}) to expose it:`, String(p)))) {
      console.log("Cancelled.");
      return;
    }
    process.exitCode = await runRemote(ip, `sudo convoy-firewall expose ${p}`);
  });

program
  .command("unexpose <vm> <port>")
  .description("Close a port opened with `expose`")
  .action(async (idOrName: string, port: string) => {
    const { ip } = await vmIp(idOrName);
    process.exitCode = await runRemote(ip, `sudo convoy-firewall unexpose ${parsePort(port)}`);
  });

program
  .command("firewall <vm>")
  .description("Show exposed ports and firewall rules on a VM")
  .action(async (idOrName: string) => {
    const { ip } = await vmIp(idOrName);
    process.exitCode = await runRemote(ip, "sudo convoy-firewall status");
  });

program
  .command("projects")
  .description("List projects, their VMs and repos")
  .action(async () => {
    const { vms } = await fleet().listVms();
    const counts = new Map<string, number>();
    for (const name of loadProjectPrefs().projects) counts.set(name, 0);
    for (const vm of vms) counts.set(vm.project ?? "(no project)", (counts.get(vm.project ?? "(no project)") ?? 0) + 1);
    if (counts.size === 0) return console.log("No agent VMs. Launch into a project with: pnpm cli --project <name> create");
    for (const [name, count] of [...counts].sort()) {
      const repos = loadProjectRepos(name === "(no project)" ? null : name);
      const reposText = repos.length > 0 ? `   repos: ${repos.join(", ")}` : "";
      console.log(`${name.padEnd(32)} ${`${count} VM${count === 1 ? "" : "s"}`.padEnd(8)}${reposText}`);
    }
  });

program
  .command("providers")
  .description("Show which cloud providers are set up")
  .action(() => {
    const { clouds, notEnabled, defaultProvider } = fleet().config;
    for (const c of clouds) {
      const { region, size } = c.defaults;
      console.log(`✓ ${c.label.padEnd(14)} ${c.name === defaultProvider ? "default · " : ""}${region} · ${size}`);
    }
    for (const c of notEnabled) console.log(`  ${c.label.padEnd(14)} not set up: ${c.setupHint}`);
  });

program
  .command("regions")
  .description("List available regions")
  .option("--size <size>", "only regions where this size can be created right now")
  .action(async (opts) => {
    const regions = await cloud().vms.provider.listRegions();
    console.table(
      regions
        .filter((r) => !opts.size || r.sizes?.includes(opts.size))
        .map(({ slug, name }) => ({ region: slug, name })),
    );
  });

program
  .command("sizes")
  .description("List VM sizes in a region")
  .option("--region <region>", "region (default from .env)")
  .action(async (opts) => {
    const sizes = await cloud().vms.provider.listSizes(opts.region);
    console.table(
      sizes
        .sort((a, b) => a.vcpus - b.vcpus || a.ramGb - b.ramGb)
        .map(({ name, vcpus, ramGb, diskGb, priceMonthly }) => ({
          name,
          vcpus,
          "ram (GB)": ramGb,
          "disk (GB)": diskGb,
          "price/mo": priceMonthly ?? "",
        })),
    );
  });

program
  .command("images")
  .description("List Linux images in a region")
  .option("--region <region>", "region (default from .env)")
  .action(async (opts) => {
    for (const name of (await cloud().vms.provider.listImages(opts.region)).sort()) console.log(name);
  });

program.parseAsync().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
