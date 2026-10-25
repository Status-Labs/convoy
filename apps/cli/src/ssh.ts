import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { VM_USER } from "@agent-platform/core";

// VMs get recycled IPs, so keep their host keys out of ~/.ssh/known_hosts.
const KNOWN_HOSTS = join(homedir(), ".config", "agent-vm", "known_hosts");

function sshArgs(ip: string, extra: string[] = []): string[] {
  mkdirSync(join(homedir(), ".config", "agent-vm"), { recursive: true });
  return [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${KNOWN_HOSTS}`,
    ...extra,
    `${VM_USER}@${ip}`,
  ];
}

export function sshCommand(ip: string): string {
  return `ssh -o UserKnownHostsFile=${KNOWN_HOSTS} ${VM_USER}@${ip}`;
}

export function openShell(ip: string): Promise<number> {
  return new Promise((resolve) => {
    spawn("ssh", sshArgs(ip), { stdio: "inherit" }).on("exit", (code) => resolve(code ?? 1));
  });
}

// Waits for sshd to come up, then blocks until cloud-init finishes on the VM.
export async function waitForCloudInit(ip: string, timeoutMs = 15 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = spawnSync(
      "ssh",
      [...sshArgs(ip, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"]), "cloud-init status --wait"],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    // 255 = ssh could not connect yet; anything else came from cloud-init.
    if (result.status === 0) return;
    if (result.status !== 255) {
      throw new Error(
        `cloud-init finished with errors (exit ${result.status}). Check /var/log/cloud-init-output.log on the VM.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error("Timed out waiting for the VM to finish setup");
}

export function forgetHostKey(ip: string): void {
  spawnSync("ssh-keygen", ["-R", ip, "-f", KNOWN_HOSTS], { stdio: "ignore" });
}
