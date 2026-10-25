import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { AgentVms, configFromEnv, type Vm } from "@agent-platform/core";
import { forgetHostKey, openShell, sshCommand, waitForCloudInit } from "./ssh";

const repoRootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
for (const path of [".env", repoRootEnv]) {
  if (existsSync(path)) {
    process.loadEnvFile(path);
    break;
  }
}

function vms(): AgentVms {
  return new AgentVms(configFromEnv());
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? homedir() + path.slice(1) : path;
}

async function findVm(idOrName: string): Promise<Vm> {
  const match = (await vms().listVms()).find((vm) => vm.id === idOrName || vm.name === idOrName);
  if (!match) throw new Error(`No agent VM with id or name "${idOrName}"`);
  return match;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

const program = new Command()
  .name("agent-vm")
  .description("Launch isolated OVHcloud VMs for running AI agent tools");

program
  .command("create")
  .description("Launch a new agent VM and wait until it is ready")
  .option("--name <name>", "instance name (default: agent-vm-<random>)")
  .option("--region <region>", "OVH region (default: OVH_REGION)")
  .option("--flavor <flavor>", "flavor name (default: OVH_FLAVOR)")
  .option("--image <image>", "image name (default: OVH_IMAGE)")
  .option("--ssh-key <path>", "public key to install", process.env.SSH_PUBLIC_KEY_PATH ?? "~/.ssh/id_ed25519.pub")
  .option("--no-wait", "return as soon as the VM is created")
  .action(async (opts) => {
    const sshPublicKey = readFileSync(expandHome(opts.sshKey), "utf8");
    const service = vms();

    const created = await service.createVm({
      sshPublicKey,
      name: opts.name,
      region: opts.region,
      flavor: opts.flavor,
      image: opts.image,
    });
    console.log(`Created ${created.name} (${created.id}) in ${created.region}`);
    if (!opts.wait) return;

    let lastStatus = "";
    const vm = await service.waitForActive(created.id, {
      onPoll: ({ status }) => {
        if (status !== lastStatus) console.log(`  status: ${status}`);
        lastStatus = status;
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
    const vm = await findVm(idOrName);
    if (!vm.publicIp) throw new Error(`${vm.name} has no public IP yet (status ${vm.status})`);
    process.exitCode = await openShell(vm.publicIp);
  });

program
  .command("delete <vm>")
  .description("Delete an agent VM (id or name)")
  .option("-y, --yes", "skip confirmation")
  .action(async (idOrName: string, opts) => {
    const vm = await findVm(idOrName);
    if (!opts.yes && !(await confirm(`Delete ${vm.name} (${vm.id})?`))) return;
    await vms().deleteVm(vm.id);
    if (vm.publicIp) forgetHostKey(vm.publicIp);
    console.log(`Deleted ${vm.name}`);
  });

program
  .command("regions")
  .description("List regions available to the project")
  .action(async () => {
    for (const region of await vms().listRegions()) console.log(region);
  });

program
  .command("flavors")
  .description("List VM sizes in a region")
  .option("--region <region>", "OVH region (default: OVH_REGION)")
  .action(async (opts) => {
    const flavors = (await vms().listFlavors(opts.region)).filter((f) => f.available);
    console.table(
      flavors
        .sort((a, b) => a.vcpus - b.vcpus || a.ram - b.ram)
        .map(({ name, vcpus, ram, disk }) => ({ name, vcpus, "ram (GB)": ram / 1024, "disk (GB)": disk })),
    );
  });

program
  .command("images")
  .description("List Linux images in a region")
  .option("--region <region>", "OVH region (default: OVH_REGION)")
  .action(async (opts) => {
    const names = new Set((await vms().listImages(opts.region)).map((i) => i.name));
    for (const name of [...names].sort()) console.log(name);
  });

program.parseAsync().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
