import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DESKTOP_INFO_SCRIPT,
  DESKTOP_PHONE_OFF_SCRIPT,
  DESKTOP_PHONE_SCRIPT,
  DESKTOP_PORT,
  DESKTOP_UNINSTALL_SCRIPT,
  METRICS_COLLECTOR,
  MetricsParser,
  VM_INFO_SCRIPT,
  parseVmInfo,
  type MetricsSample,
  type VmInfo,
  TAILSCALE_LEAVE_SCRIPT,
  cloneScript,
  desktopInstallScript,
  parseCloneOutput,
  VM_USER,
  keySetupScript,
  tailscaleJoinScript,
  type AgentKeys,
  type CloneResult,
  type GitIdentity,
  type RepoRef,
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

/** The tmux session `t` attaches to; created on first use. */
export const TMUX_SESSION = "agent";

// Attaches to the VM's persistent tmux session, creating it if needed.
// Programs in it keep running after you disconnect (Ctrl+B then D detaches).
export function openTmux(ip: string): Promise<number> {
  return run([...sshArgs(ip, ["-t"]), `tmux new-session -A -s ${TMUX_SESSION}`], "inherit");
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

/**
 * Configures the VM's agent tools with the API keys from .env, signs git in
 * with the GitHub token and sets the commit identity. Returns false if there
 * was nothing to set up.
 */
export async function installKeys(ip: string, keys: AgentKeys, identity?: GitIdentity | null): Promise<boolean> {
  const script = keySetupScript(keys, identity);
  if (!script) return false;
  const { code, stderr } = await runScript(ip, script, { timeoutMs: 3 * 60_000 });
  if (code !== 0) throw new Error(`couldn't set up keys on the VM: ${stderr.split("\n").at(-1) || `exit ${code}`}`);
  return true;
}

/** The commit author from the local git config, or null if it isn't set. */
export function localGitIdentity(): GitIdentity | null {
  const get = (key: string) => spawnSync("git", ["config", "--get", key], { encoding: "utf8" }).stdout?.trim();
  const name = get("user.name");
  const email = get("user.email");
  return name && email ? { name, email } : null;
}

/** Clones GitHub repos into the VM's home directory, skipping ones already there. */
export async function cloneRepos(ip: string, repos: { repo: RepoRef; dir?: string }[]): Promise<CloneResult[]> {
  if (repos.length === 0) return [];
  const { code, stdout, stderr } = await runScript(ip, cloneScript(repos), { timeoutMs: 15 * 60_000 });
  if (code !== 0) throw new Error(`couldn't clone repos: ${stderr.split("\n").at(-1) || `exit ${code}`}`);
  return parseCloneOutput(stdout);
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

/** Installs the desktop on an existing VM, showing the install's progress. */
export function installDesktop(ip: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("ssh", [...sshArgs(ip, ["-o", "BatchMode=yes"]), "sudo bash -s"], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
    child.stdin.end(desktopInstallScript());
  });
}

/** Removes the desktop from a VM to free its RAM and disk. */
export async function uninstallDesktop(ip: string): Promise<void> {
  const { code, stderr } = await runScript(ip, DESKTOP_UNINSTALL_SCRIPT, { timeoutMs: 10 * 60_000 });
  if (code === 3) throw new Error("this VM has no desktop");
  if (code !== 0) throw new Error(`couldn't remove the desktop: ${stderr.split("\n").at(-1) || `exit ${code}`}`);
}

/** The VM's desktop password, or null if it has no desktop. */
export async function desktopPassword(ip: string): Promise<string | null> {
  const { code, stdout, stderr } = await runScript(ip, DESKTOP_INFO_SCRIPT, { timeoutMs: 60_000 });
  if (code === 3) return null;
  if (code !== 0 || !stdout) throw new Error(`couldn't read the desktop password: ${stderr || `exit ${code}`}`);
  return stdout;
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => server.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" })
      .once("connect", () => (socket.destroy(), resolve(true)))
      .once("error", () => resolve(false));
  });
}

export interface DesktopTunnel {
  url: string;
  /** Resolves when the tunnel ends (closed, or the connection dropped). */
  closed: Promise<void>;
  close(): void;
}

/**
 * Tunnels the VM's desktop to localhost and resolves once it's reachable.
 * Uses the desktop's own port locally when it's free, so the browser
 * remembers the password for it.
 */
export async function openDesktopTunnel(ip: string): Promise<DesktopTunnel> {
  let port = DESKTOP_PORT;
  while (!(await portIsFree(port))) port++;
  const child: ChildProcess = spawn(
    "ssh",
    sshArgs(ip, ["-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-L", `${port}:127.0.0.1:${DESKTOP_PORT}`]),
    { stdio: "ignore" },
  );
  const closed = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let exited = false;
  void closed.then(() => (exited = true));
  const deadline = Date.now() + 20_000;
  while (!(await canConnect(port))) {
    if (exited || Date.now() > deadline) {
      child.kill();
      throw new Error("couldn't open an SSH tunnel to the desktop");
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { url: `http://localhost:${port}`, closed, close: () => child.kill() };
}

/** Serves the desktop to the tailnet over HTTPS and returns its URL. */
export async function serveDesktopToTailnet(ip: string): Promise<string> {
  const { code, stdout, stderr } = await runScript(ip, DESKTOP_PHONE_SCRIPT, { timeoutMs: 90_000 });
  if (code === 0 && stdout) return stdout.split("\n").at(-1)!;
  if (code === 3) throw new Error("this VM has no desktop. Add one with: pnpm cli desktop <vm> --install");
  if (code === 4) throw new Error("this VM isn't on your tailnet. Add it with: pnpm cli tailscale <vm>");
  if (code === 5) {
    throw new Error(
      "HTTPS is off in your tailnet. Turn on HTTPS Certificates at https://login.tailscale.com/admin/dns, then retry",
    );
  }
  throw new Error(`couldn't serve the desktop to your tailnet: ${stderr.split("\n").at(-1) || `exit ${code}`}`);
}

export async function stopServingDesktop(ip: string): Promise<void> {
  const { code, stderr } = await runScript(ip, DESKTOP_PHONE_OFF_SCRIPT, { timeoutMs: 30_000 });
  if (code !== 0) throw new Error(`couldn't stop serving the desktop: ${stderr || `exit ${code}`}`);
}

/** What's on the VM: setup state, tool versions, desktop, tailnet, GitHub, repos. */
export async function vmInfo(ip: string): Promise<VmInfo> {
  const { code, stdout, stderr } = await runScript(ip, VM_INFO_SCRIPT, { timeoutMs: 30_000 });
  if (code !== 0) throw new Error(stderr.split("\n").at(-1) || `couldn't reach the VM (exit ${code})`);
  return parseVmInfo(stdout);
}

/**
 * Streams live metrics from the VM over one long-lived SSH connection until
 * stopped, reconnecting with backoff if it drops. onStatus reports
 * "connecting" / "live" / "reconnecting".
 */
export function streamMetrics(
  ip: string,
  onSample: (sample: MetricsSample) => void,
  onStatus: (status: "connecting" | "live" | "reconnecting") => void = () => {},
): () => void {
  let stopped = false;
  let child: ChildProcess | null = null;
  let timer: NodeJS.Timeout | null = null;
  let failures = 0;

  const start = () => {
    if (stopped) return;
    onStatus(failures === 0 ? "connecting" : "reconnecting");
    const parser = new MetricsParser((sample) => {
      failures = 0;
      onStatus("live");
      onSample(sample);
    });
    const current = spawn("ssh", [...sshArgs(ip, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=10"]), "sh -s"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    child = current;
    current.stdout!.setEncoding("utf8").on("data", (chunk: string) => parser.feed(chunk));
    current.on("exit", () => {
      if (stopped) return;
      failures++;
      timer = setTimeout(start, Math.min(30_000, 1_000 * 2 ** failures));
    });
    current.on("error", () => {});
    // sh parses the whole loop before running it, so stdin can close now.
    current.stdin!.end(METRICS_COLLECTOR);
  };
  start();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    child?.kill();
  };
}

/** Opens a URL in the user's browser. Best effort. */
export function openInBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(command, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

// Trusts bootstrap.sh's markers, not cloud-init's status, which reads "done"
// after a reboot even if setup failed. Exit codes: 0 ready, 1 failed (prints
// the failed step), 100 reboot pending, 101 still running (prints the phase).
const SETUP_CHECK = [
  "state=/var/lib/agent-vm",
  "case \"$(cloud-init status 2>/dev/null)\" in *running*|*'not started'*)",
  "  if [ -f $state/phase ]; then cat $state/phase; elif [ -f $state/ready ]; then echo 'finishing up'; else echo 'updating packages'; fi",
  "  exit 101;; esac",
  "if [ -f $state/failed ]; then cat $state/failed; exit 1; fi",
  "if [ ! -f $state/ready ]; then echo 'setup did not run'; exit 1; fi",
  "if [ -f /var/run/reboot-required ]; then exit 100; fi",
  "exit 0",
].join("\n");

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
// the post-setup reboot if there is one. Reports setup's current phase
// ("adding Claude Code", "rebooting") through onPhase.
export async function waitForCloudInit(
  ip: string,
  { timeoutMs = 20 * 60_000, onPhase = (_phase: string) => {} } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let booted = false;
  while (Date.now() < deadline) {
    const { code, stdout } = await capture([
      ...sshArgs(ip, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"]),
      SETUP_CHECK,
    ]);
    if (code === 0) return;
    // 255 = ssh could not connect (booting or rebooting); 100 = reboot pending.
    if (code === 255) onPhase(booted ? "rebooting" : "booting");
    else if (code === 100) onPhase("rebooting");
    else if (code === 101) onPhase(stdout || "installing tools");
    else {
      throw new Error(
        `setup failed at "${stdout || "unknown step"}"; see /var/log/cloud-init-output.log on the VM`,
      );
    }
    if (code !== 255) booted = true;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error("timed out waiting for setup to finish");
}

export function forgetHostKey(ip: string): void {
  spawnSync("ssh-keygen", ["-R", ip, "-f", KNOWN_HOSTS], { stdio: "ignore" });
}
