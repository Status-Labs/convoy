import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { AgentVms, configFromEnv, createProvider } from "@agent-platform/core";
import { forgetHostKey, openShell, sshCommand, waitForCloudInit } from "./ssh";

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

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

const program = new Command()
  .name("agent-vm")
  .description("Launch isolated cloud VMs for running AI agent tools")
  .option("-p, --provider <name>", "cloud provider: digitalocean or ovh (default: PROVIDER, else digitalocean)")
  .hook("preAction", (cmd) => {
    const { provider } = cmd.opts();
    if (provider) process.env.PROVIDER = provider;
  });

program
  .command("create")
  .description("Launch a new agent VM and wait until it is ready")
  .option("--name <name>", "VM name (default: agent-vm-<random>)")
  .option("--region <region>", "region (default from .env)")
  .option("--size <size>", "size / flavor name (default from .env)")
  .option("--image <image>", "image name (default from .env)")
  .option("--ssh-key <path>", "public key to install", process.env.SSH_PUBLIC_KEY_PATH ?? "~/.ssh/id_ed25519.pub")
  .option("--no-wait", "return as soon as the VM is created")
  .action(async (opts) => {
    const sshPublicKey = readFileSync(expandHome(opts.sshKey), "utf8");

    const created = await vms().launch({
      sshPublicKey,
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
