import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  TAILSCALE_LEAVE_SCRIPT,
  VM_USER,
  keySetupScript,
  tailscaleJoinScript,
  type AgentKeys,
} from "@agent-platform/core";

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

// Runs a bash script on the VM, passed on stdin so secrets in it never show up
// in command lines or process listings.
export function runScript(
  ip: string,
  script: string,
  { timeoutMs }: { timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("ssh", [...sshArgs(ip, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]), "bash -s"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.on("error", (err) => resolve({ code: 1, stdout: "", stderr: err.message }));
    child.stdin.end(script);
  });
}

/** Configures the VM's agent tools with the API keys from .env. */
export async function installKeys(ip: string, keys: AgentKeys): Promise<boolean> {
  const script = keySetupScript(keys);
  if (!script) return false;
  const { code, stderr } = await runScript(ip, script);
  if (code !== 0) throw new Error(`couldn't set up API keys on the VM: ${stderr || `exit ${code}`}`);
  return true;
}

/** Joins the VM to the user's tailnet with the auth key from .env. Returns its tailnet name. */
export async function joinTailnet(ip: string, authKey: string, hostname: string): Promise<string> {
  const { code, stdout, stderr } = await runScript(ip, tailscaleJoinScript(authKey, hostname), { timeoutMs: 5 * 60_000 });
  if (code !== 0) throw new Error(`couldn't join the tailnet: ${stderr.split("\n").at(-1) || `exit ${code}`}`);
  return stdout.split("\n").at(-1) || hostname;
}

/**
 * Signs a VM out of the tailnet before it's deleted, so it doesn't linger in
 * the user's device list. Best effort: never blocks a delete.
 */
export async function leaveTailnet(ip: string): Promise<void> {
  await runScript(ip, TAILSCALE_LEAVE_SCRIPT, { timeoutMs: 20_000 });
}

// Runs a script on the VM in an interactive terminal. The script travels
// base64-encoded in the command line, so it must not contain secrets.
export function runInteractive(ip: string, script: string): Promise<number> {
  const encoded = Buffer.from(script).toString("base64");
  return run([...sshArgs(ip, ["-t"]), `bash -c "$(echo ${encoded} | base64 -d)"`], "inherit");
}

// Tunnels localhost:<localPort> to <remotePort> on the VM until interrupted.
// Nothing is opened on the VM's firewall.
export function forwardPort(ip: string, localPort: number, remotePort: number): Promise<number> {
  return run(
    [...sshArgs(ip, ["-N", "-o", "ExitOnForwardFailure=yes", "-L", `${localPort}:localhost:${remotePort}`])],
    "inherit",
  );
}

// Runs on the VM once cloud-init is idle. Trusts bootstrap.sh's markers, not
// cloud-init's status, which reads "done" after a reboot even if setup failed.
// Exit codes: 0 ready, 1 failed (prints the failed step), 100 reboot pending.
const SETUP_CHECK = [
  "cloud-init status --wait >/dev/null 2>&1",
  "if [ -f /var/lib/agent-vm/failed ]; then cat /var/lib/agent-vm/failed; exit 1; fi",
  "if [ ! -f /var/lib/agent-vm/ready ]; then echo 'setup did not run'; exit 1; fi",
  "if [ -f /var/run/reboot-required ]; then exit 100; fi",
  "exit 0",
].join("; ");

function capture(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout: stdout.trim() }));
    child.on("error", () => resolve({ code: 1, stdout: "" }));
  });
}

// Waits for sshd to come up, then until setup finishes on the VM, including
// the post-setup reboot if there is one.
export async function waitForCloudInit(ip: string, timeoutMs = 20 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { code, stdout } = await capture([
      ...sshArgs(ip, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"]),
      SETUP_CHECK,
    ]);
    // 255 = ssh could not connect (booting or rebooting); 100 = reboot pending.
    if (code === 0) return;
    if (code !== 255 && code !== 100) {
      throw new Error(
        `setup failed at "${stdout || "unknown step"}"; see /var/log/cloud-init-output.log on the VM`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error("timed out waiting for setup to finish");
}

export function forgetHostKey(ip: string): void {
  spawnSync("ssh-keygen", ["-R", ip, "-f", KNOWN_HOSTS], { stdio: "ignore" });
}
