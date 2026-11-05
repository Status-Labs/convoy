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
  parseToolIds,
  type Cloud,
  type SignInMode,
} from "@agent-platform/core";
import QRCode from "qrcode";
import {
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
  openShell,
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

const program = new Command()
  .name("agent-vm")
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
  .option("--name <name>", "VM name (default: agent-vm-<random>)")
  .option("--region <region>", "region (default from .env)")
  .option("--size <size>", "size / flavor name (default from .env)")
  .option("--image <image>", "image name (default from .env)")
  .option("--ssh-key <path>", "public key to install", defaultSshKey)
  .option("--tools <ids>", `comma-separated tools to install, or "none" (default: all: ${ALL_TOOL_IDS.join(",")})`)
  .option("--api-keys", "set up tools with the API keys in .env (default: sign in yourself with `login`)")
  .option("--tailscale", "put the VM on your tailnet for phone access (joins with TAILSCALE_AUTH_KEY, else `login`)")
  .option("--desktop", "install a Linux desktop you open in a browser (`desktop <vm>`); needs 4 GB+ RAM")
  .option("--no-wait", "return as soon as the VM is created")
  .action(async (opts) => {
    const sshPublicKey = readFileSync(expandHome(opts.sshKey), "utf8");
    const keys = agentKeysFromEnv();
    const mode: SignInMode = opts.apiKeys ? "api-keys" : "subscription";
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

    console.log("  installing tools (cloud-init)...");
    await waitForCloudInit(vm.publicIp!);
    if (mode === "api-keys" && (await installKeys(vm.publicIp!, keys))) {
      console.log("  agent tools set up with your API keys");
    }
    const tailnetName = opts.tailscale && keys.tailscale ? await joinTailnet(vm.publicIp!, keys.tailscale, vm.name) : null;
    console.log(`Ready. Connect with:\n  pnpm cli ssh ${vm.name}\n  ${sshCommand(vm.publicIp!)}`);
    if (tailnetName) console.log(`From your phone (Tailscale app + an SSH app):\n  ssh agent@${tailnetName}`);
    if (opts.desktop) console.log(`Open the desktop with:\n  pnpm cli desktop ${vm.name}${tailnetName ? ` (add --phone for your phone)` : ""}`);
    if (mode === "subscription" || (opts.tailscale && !keys.tailscale)) {
      console.log(`Sign in ${opts.tailscale && !keys.tailscale ? "agent tools and Tailscale" : "agent tools"} with:\n  pnpm cli login ${vm.name}`);
    }
  });

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
  .action(async (idOrName: string) => {
    const { vm } = await fleet().findVm(idOrName);
    if (!vm.publicIp) throw new Error(`${vm.name} has no public IP yet (status ${vm.status})`);
    process.exitCode = await openShell(vm.publicIp);
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
  .description("Set up the VM's agent tools with the API keys in .env (e.g. after changing a key)")
  .action(async (idOrName: string) => {
    const { name, ip } = await vmIp(idOrName);
    if (!(await installKeys(ip, agentKeysFromEnv()))) {
      throw new Error("No ANTHROPIC_API_KEY or OPENAI_API_KEY in .env (see .env.example).");
    }
    console.log(`Agent tools on ${name} now use the API keys from .env.`);
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
  .option("--phone", "serve the desktop to your tailnet over HTTPS and show a QR code to open it on your phone")
  .option("--phone-off", "stop serving the desktop to your tailnet")
  .option("--no-open", "don't open the browser, just print the address")
  .action(async (idOrName: string, opts) => {
    const { name, ip } = await vmIp(idOrName);
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
  });

program
  .command("delete <vm>")
  .description("Delete an agent VM (id or name)")
  .option("-y, --yes", "skip confirmation")
  .action(async (idOrName: string, opts) => {
    const { vm, cloud } = await fleet().findVm(idOrName);
    if (!opts.yes && !(await confirm(`Delete ${vm.name} (${vm.id}) on ${cloud.label}?`))) return;
    if (vm.status === "running" && vm.publicIp) await leaveTailnet(vm.publicIp);
    await cloud.vms.provider.deleteVm(vm.id);
    if (vm.publicIp) forgetHostKey(vm.publicIp);
    console.log(`Deleted ${vm.name}`);
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
        "authentication, and close the port again with `agent-vm unexpose` when done.",
        `If you only need to reach it yourself, use instead:  pnpm cli forward ${name} ${p}`,
        "",
      ].join("\n"),
    );
    if (!opts.yes && !(await confirm(`Type the port number (${p}) to expose it:`, String(p)))) {
      console.log("Cancelled.");
      return;
    }
    process.exitCode = await runRemote(ip, `sudo agent-vm-firewall expose ${p}`);
  });

program
  .command("unexpose <vm> <port>")
  .description("Close a port opened with `expose`")
  .action(async (idOrName: string, port: string) => {
    const { ip } = await vmIp(idOrName);
    process.exitCode = await runRemote(ip, `sudo agent-vm-firewall unexpose ${parsePort(port)}`);
  });

program
  .command("firewall <vm>")
  .description("Show exposed ports and firewall rules on a VM")
  .action(async (idOrName: string) => {
    const { ip } = await vmIp(idOrName);
    process.exitCode = await runRemote(ip, "sudo agent-vm-firewall status");
  });

program
  .command("projects")
  .description("List projects that have VMs")
  .action(async () => {
    const { vms } = await fleet().listVms();
    const counts = new Map<string, number>();
    for (const vm of vms) counts.set(vm.project ?? "(no project)", (counts.get(vm.project ?? "(no project)") ?? 0) + 1);
    if (counts.size === 0) return console.log("No agent VMs. Launch into a project with: pnpm cli --project <name> create");
    for (const [name, count] of [...counts].sort()) console.log(`${name.padEnd(32)} ${count} VM${count === 1 ? "" : "s"}`);
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
