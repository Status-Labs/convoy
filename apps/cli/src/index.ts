import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { ALL_TOOL_IDS, AgentVms, configFromEnv, createProvider, parseToolIds } from "@agent-platform/core";
import { forgetHostKey, forwardPort, openShell, runRemote, sshCommand, waitForCloudInit } from "./ssh";
import { runTui } from "./tui/run";

const repoRootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
for (const path of [".env", repoRootEnv]) {
  if (existsSync(path)) {
    process.loadEnvFile(path);
    break;
  }
}

let cached: AgentVms | undefined;
function vms(): AgentVms {
  return (cached ??= new AgentVms(createProvider(configFromEnv())));
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
  const vm = await vms().findVm(idOrName);
  if (!vm.publicIp) throw new Error(`${vm.name} has no public IP yet (status ${vm.status})`);
  return { name: vm.name, ip: vm.publicIp };
}

const program = new Command()
  .name("agent-vm")
  .description("Launch isolated cloud VMs for running AI agent tools")
  .option("-p, --provider <name>", "cloud provider: digitalocean or ovh (default: PROVIDER, else digitalocean)")
  .hook("preAction", (cmd) => {
    const { provider } = cmd.opts();
    if (provider) process.env.PROVIDER = provider;
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
  .option("--no-wait", "return as soon as the VM is created")
  .action(async (opts) => {
    const sshPublicKey = readFileSync(expandHome(opts.sshKey), "utf8");
    const tools =
      opts.tools === undefined ? ALL_TOOL_IDS
      : opts.tools === "none" ? []
      : parseToolIds(opts.tools.split(",").map((id: string) => id.trim()).filter(Boolean));

    const created = await vms().launch({
      sshPublicKey,
      tools,
      name: opts.name,
      region: opts.region,
      size: opts.size,
      image: opts.image,
    });
    console.log(`Created ${created.name} (${created.id}) on ${vms().provider.name} in ${created.region}`);
    if (!opts.wait) return;

    let lastStatus = "";
    const vm = await vms().waitForRunning(created.id, {
      onPoll: ({ providerStatus }) => {
        if (providerStatus !== lastStatus) console.log(`  status: ${providerStatus}`);
        lastStatus = providerStatus;
      },
    });
    console.log(`  public IP: ${vm.publicIp}`);

    console.log("  installing tools (cloud-init)...");
    await waitForCloudInit(vm.publicIp!);
    console.log(`Ready. Connect with:\n  pnpm cli ssh ${vm.name}\n  ${sshCommand(vm.publicIp!)}`);
  });

program
  .command("list")
  .description("List agent VMs")
  .action(async () => {
    const list = await vms().listVms();
    if (list.length === 0) return console.log("No agent VMs.");
    console.table(
      list.map(({ name, id, status, region, publicIp, createdAt }) => ({ name, id, status, region, publicIp, createdAt })),
    );
  });

program
  .command("ssh <vm>")
  .description("Open a shell on an agent VM (id or name)")
  .action(async (idOrName: string) => {
    const vm = await vms().findVm(idOrName);
    if (!vm.publicIp) throw new Error(`${vm.name} has no public IP yet (status ${vm.status})`);
    process.exitCode = await openShell(vm.publicIp);
  });

program
  .command("delete <vm>")
  .description("Delete an agent VM (id or name)")
  .option("-y, --yes", "skip confirmation")
  .action(async (idOrName: string, opts) => {
    const vm = await vms().findVm(idOrName);
    if (!opts.yes && !(await confirm(`Delete ${vm.name} (${vm.id})?`))) return;
    await vms().provider.deleteVm(vm.id);
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
  .command("regions")
  .description("List available regions")
  .action(async () => {
    for (const region of await vms().provider.listRegions()) console.log(region);
  });

program
  .command("sizes")
  .description("List VM sizes in a region")
  .option("--region <region>", "region (default from .env)")
  .action(async (opts) => {
    const sizes = await vms().provider.listSizes(opts.region);
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
    for (const name of (await vms().provider.listImages(opts.region)).sort()) console.log(name);
  });

program.parseAsync().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
