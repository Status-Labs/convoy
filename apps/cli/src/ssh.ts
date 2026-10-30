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

function run(args: string[], stdio: "inherit" | "ignore"): Promise<number> {
  return new Promise((resolve) => {
    spawn("ssh", args, { stdio })
      .on("exit", (code) => resolve(code ?? 1))
      .on("error", () => resolve(1));
  });
}

export function sshCommand(ip: string): string {
  return `ssh -o UserKnownHostsFile=${KNOWN_HOSTS} ${VM_USER}@${ip}`;
}

export function openShell(ip: string): Promise<number> {
  return run(sshArgs(ip), "inherit");
}

export function runRemote(ip: string, command: string): Promise<number> {
  return run([...sshArgs(ip), command], "inherit");
}

// Tunnels localhost:<localPort> to <remotePort> on the VM until interrupted.
// Nothing is opened on the VM's firewall.
export function forwardPort(ip: string, localPort: number, remotePort: number): Promise<number> {
  return run(
    [...sshArgs(ip, ["-N", "-o", "ExitOnForwardFailure=yes", "-L", `${localPort}:localhost:${remotePort}`])],
    "inherit",
  );
}

// Exit codes: 0 done, 1 failed, 2 done with warnings (cloud-init >= 23.4),
// 100 done but a reboot is pending (cloud-init's power_state is about to reboot).
const CLOUD_INIT_CHECK =
  "cloud-init status --wait >/dev/null; s=$?; " +
  "if [ $s -ne 1 ] && [ -f /var/run/reboot-required ]; then exit 100; fi; exit $s";

// Waits for sshd to come up, then until cloud-init finishes on the VM,
// including the post-setup reboot if there is one.
export async function waitForCloudInit(ip: string, timeoutMs = 20 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const code = await run(
      [...sshArgs(ip, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"]), CLOUD_INIT_CHECK],
      "ignore",
    );
    // 255 = ssh could not connect (booting or rebooting); 100 = reboot pending.
    if (code === 0 || code === 2) return;
    if (code !== 255 && code !== 100) {
      throw new Error(`setup finished with errors (exit ${code}); see /var/log/cloud-init-output.log on the VM`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error("timed out waiting for setup to finish");
}

export function forgetHostKey(ip: string): void {
  spawnSync("ssh-keygen", ["-R", ip, "-f", KNOWN_HOSTS], { stdio: "ignore" });
}
