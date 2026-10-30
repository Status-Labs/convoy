import { readFileSync } from "node:fs";
import { useCallback, useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { Spinner } from "@inkjs/ui";
import { AGENT_TOOLS, ALL_TOOL_IDS, newVmName, type AgentVms, type ToolId, type Vm } from "@agent-platform/core";
import { forgetHostKey, openShell, waitForCloudInit } from "../ssh";

type Phase = "creating" | "booting" | "installing" | "ready" | "failed";

// A VM launched in this session, tracked through setup.
interface Job {
  name: string;
  phase: Phase;
  vmId?: string;
}

interface Row {
  key: string;
  name: string;
  id?: string;
  vm?: Vm;
  job?: Job;
  deleting: boolean;
}

type Message = { text: string; tone: "info" | "success" | "error" } | null;

export interface AppProps {
  vms: AgentVms;
  summary: string;
  sshKeyPath: string;
}

const REFRESH_MS = 10_000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function age(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

export function App({ vms, summary, sshKeyPath }: AppProps) {
  const { exit, suspendTerminal } = useApp();
  const [list, setList] = useState<Vm[] | null>(null);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<Row | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [picking, setPicking] = useState(false);
  const [lastTools, setLastTools] = useState<ToolId[]>(ALL_TOOL_IDS);

  const refresh = useCallback(async () => {
    try {
      const vmList = await vms.listVms();
      setList(vmList.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch (err) {
      setList((current) => current ?? []);
      setMessage({ text: errorText(err), tone: "error" });
    }
  }, [vms]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const updateJob = (name: string, patch: Partial<Job>) =>
    setJobs((current) => ({ ...current, [name]: { ...current[name], name, phase: "creating", ...patch } as Job }));

  // Newly launched VMs show up before the provider lists them.
  const listed = list ?? [];
  const listedNames = new Set(listed.map((vm) => vm.name));
  const rows: Row[] = [
    ...Object.values(jobs)
      .filter((job) => !listedNames.has(job.name) && (job.phase === "creating" || job.phase === "booting"))
      .map((job) => ({ key: job.name, name: job.name, id: job.vmId, job, deleting: false })),
    ...listed.map((vm) => ({
      key: vm.id,
      name: vm.name,
      id: vm.id,
      vm,
      job: jobs[vm.name],
      deleting: deleting.has(vm.id),
    })),
  ];
  const current = Math.min(selected, rows.length - 1);

  async function launch(tools: ToolId[]) {
    setPicking(false);
    setLastTools(tools);
    let sshPublicKey: string;
    try {
      sshPublicKey = readFileSync(sshKeyPath, "utf8");
    } catch {
      setMessage({ text: `Can't read SSH public key at ${sshKeyPath}. Set SSH_PUBLIC_KEY_PATH in .env.`, tone: "error" });
      return;
    }

    const name = newVmName();
    updateJob(name, { phase: "creating" });
    setSelected(0);
    setMessage(null);
    try {
      const created = await vms.launch({ sshPublicKey, name, tools });
      updateJob(name, { phase: "booting", vmId: created.id });
      void refresh();
      const vm = await vms.waitForRunning(created.id);
      updateJob(name, { phase: "installing" });
      void refresh();
      await waitForCloudInit(vm.publicIp!);
      updateJob(name, { phase: "ready" });
      setMessage({ text: `${name} is ready. Select it and press enter to connect.`, tone: "success" });
    } catch (err) {
      updateJob(name, { phase: "failed" });
      setMessage({ text: `${name}: ${errorText(err)}`, tone: "error" });
    }
  }

  async function connect(row: Row) {
    const ip = row.vm?.publicIp;
    if (!ip) {
      setMessage({ text: `${row.name} has no IP address yet.`, tone: "info" });
      return;
    }
    await suspendTerminal(async () => {
      process.stdout.write(`Connecting to ${row.name} (${ip}). Type "exit" to come back.\n`);
      await openShell(ip);
    });
    void refresh();
  }

  async function remove(row: Row) {
    const id = row.id!;
    setDeleting((current) => new Set(current).add(id));
    try {
      await vms.provider.deleteVm(id);
      if (row.vm?.publicIp) forgetHostKey(row.vm.publicIp);
      setJobs(({ [row.name]: _, ...rest }) => rest);
      setMessage({ text: `Deleted ${row.name}.`, tone: "info" });
      void refresh();
    } catch (err) {
      setDeleting((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      setMessage({ text: `Couldn't delete ${row.name}: ${errorText(err)}`, tone: "error" });
    }
  }

  useInput((input, key) => {
    if (confirmDelete) {
      if (input.toLowerCase() === "y") void remove(confirmDelete);
      setConfirmDelete(null);
      return;
    }

    if (input === "q" || key.escape) return exit();
    if (input === "n") return setPicking(true);
    if (input === "r") {
      setMessage(null);
      return void refresh();
    }
    if (key.upArrow || input === "k") return setSelected(Math.max(0, current - 1));
    if (key.downArrow || input === "j") return setSelected(Math.min(rows.length - 1, current + 1));

    const row = rows[current];
    if (!row) return;
    if (key.return) return void connect(row);
    if (input === "d") {
      if (!row.id) return setMessage({ text: `${row.name} is still being created.`, tone: "info" });
      if (!row.deleting) setConfirmDelete(row);
    }
  }, { isActive: !picking });

  const header = (
    <Box gap={2} marginBottom={1}>
      <Text bold color="cyan">
        agent-vm
      </Text>
      <Text dimColor>{summary}</Text>
    </Box>
  );

  if (picking) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        {header}
        <ToolPicker initial={lastTools} onLaunch={launch} onCancel={() => setPicking(false)} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {header}

      {list === null ? (
        <Spinner label="Loading VMs…" />
      ) : rows.length === 0 ? (
        <Text>
          No agent VMs yet. Press <Text bold color="cyan">n</Text> to launch one.
        </Text>
      ) : (
        <VmTable rows={rows} selected={current} />
      )}

      <Box marginTop={1}>
        {confirmDelete ? (
          <Text color="yellow">
            Delete {confirmDelete.name}? This destroys the VM and everything on it. <Text bold>y/N</Text>
          </Text>
        ) : message ? (
          <Text color={message.tone === "error" ? "red" : message.tone === "success" ? "green" : undefined}>
            {message.tone === "error" ? "✗ " : message.tone === "success" ? "✓ " : ""}
            {message.text}
          </Text>
        ) : (
          <Text> </Text>
        )}
      </Box>

      <Box marginTop={1} gap={2}>
        <Key k="n" label="new" />
        <Key k="⏎" label="connect" />
        <Key k="d" label="delete" />
        <Key k="r" label="refresh" />
        <Key k="q" label="quit" />
      </Box>
    </Box>
  );
}

const COLUMNS = { name: 18, status: 22, ip: 17, region: 8 };

function VmTable({ rows, selected }: { rows: Row[]; selected: number }) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>
          {"  "}
          {"NAME".padEnd(COLUMNS.name)}
          {"STATUS".padEnd(COLUMNS.status)}
          {"IP".padEnd(COLUMNS.ip)}
          {"REGION".padEnd(COLUMNS.region)}
          AGE
        </Text>
      </Box>
      {rows.map((row, index) => {
        const isSelected = index === selected;
        return (
          <Box key={row.key}>
            <Text color="cyan">{isSelected ? "❯ " : "  "}</Text>
            <Box width={COLUMNS.name}>
              <Text bold={isSelected}>{row.name}</Text>
            </Box>
            <Box width={COLUMNS.status}>
              <StatusCell row={row} />
            </Box>
            <Box width={COLUMNS.ip}>
              <Text dimColor={!row.vm?.publicIp}>{row.vm?.publicIp ?? "—"}</Text>
            </Box>
            <Box width={COLUMNS.region}>
              <Text>{row.vm?.region ?? ""}</Text>
            </Box>
            <Text dimColor>{row.vm ? age(row.vm.createdAt) : ""}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

const PHASE_LABELS: Record<Phase, string> = {
  creating: "creating",
  booting: "booting",
  installing: "installing tools",
  ready: "ready",
  failed: "setup failed",
};

function StatusCell({ row }: { row: Row }) {
  if (row.deleting) return <Spinner label="deleting" />;

  const phase = row.job?.phase;
  if (phase === "creating" || phase === "booting" || phase === "installing") {
    return <Spinner label={PHASE_LABELS[phase]} />;
  }
  if (phase === "ready") return <Text color="green">● ready</Text>;
  if (phase === "failed") return <Text color="red">✗ {PHASE_LABELS.failed}</Text>;

  switch (row.vm?.status) {
    case "running":
      return <Text color="green">● running</Text>;
    case "provisioning":
      return <Spinner label="starting" />;
    case "stopped":
      return <Text dimColor>○ stopped</Text>;
    case "error":
      return <Text color="red">✗ error</Text>;
    default:
      return <Text dimColor>{row.vm?.providerStatus ?? ""}</Text>;
  }
}

interface ToolPickerProps {
  initial: ToolId[];
  onLaunch: (tools: ToolId[]) => void;
  onCancel: () => void;
}

function ToolPicker({ initial, onLaunch, onCancel }: ToolPickerProps) {
  const [cursor, setCursor] = useState(0);
  const [chosen, setChosen] = useState<Set<ToolId>>(new Set(initial));

  useInput((input, key) => {
    if (key.escape || input === "q") return onCancel();
    if (key.upArrow || input === "k") return setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow || input === "j") return setCursor((c) => Math.min(AGENT_TOOLS.length - 1, c + 1));
    if (input === " ") {
      const id = AGENT_TOOLS[cursor]!.id;
      return setChosen((current) => {
        const next = new Set(current);
        if (!next.delete(id)) next.add(id);
        return next;
      });
    }
    if (input === "a") {
      return setChosen((current) => new Set(current.size === AGENT_TOOLS.length ? [] : ALL_TOOL_IDS));
    }
    if (key.return) onLaunch(AGENT_TOOLS.filter((tool) => chosen.has(tool.id)).map((tool) => tool.id));
  });

  return (
    <Box flexDirection="column">
      <Text bold>New VM: choose tools to install</Text>
      <Box flexDirection="column" marginTop={1}>
        {AGENT_TOOLS.map((tool, index) => {
          const isCursor = index === cursor;
          const isChosen = chosen.has(tool.id);
          return (
            <Box key={tool.id}>
              <Text color="cyan">{isCursor ? "❯ " : "  "}</Text>
              <Text color={isChosen ? "green" : undefined} dimColor={!isChosen}>
                {isChosen ? "[x] " : "[ ] "}
              </Text>
              <Box width={16}>
                <Text bold={isCursor}>{tool.name}</Text>
              </Box>
              <Text dimColor>{tool.description}</Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Always included: security updates, firewall (SSH only), fail2ban,</Text>
        <Text dimColor>automatic security patches, git, Node.js, Python, tmux.</Text>
      </Box>

      <Box marginTop={1} gap={2}>
        <Key k="space" label="toggle" />
        <Key k="a" label="all/none" />
        <Key k="⏎" label={chosen.size === 0 ? "launch (no tools)" : `launch (${chosen.size})`} />
        <Key k="esc" label="cancel" />
      </Box>
    </Box>
  );
}

function Key({ k, label }: { k: string; label: string }) {
  return (
    <Text>
      <Text bold color="cyan">
        {k}
      </Text>
      <Text dimColor> {label}</Text>
    </Text>
  );
}

export function SetupNeeded({ error }: { error: string }) {
  const { exit } = useApp();
  useInput(() => exit());

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>
      <Text bold color="cyan">
        agent-vm
      </Text>
      <Text color="yellow">{error}</Text>
      <Box flexDirection="column">
        <Text>To get started:</Text>
        <Text>
          {"  "}1. <Text bold>cp .env.example .env</Text>
        </Text>
        <Text>
          {"  "}2. Set <Text bold>DIGITALOCEAN_TOKEN</Text> (or PROVIDER=ovh and the OVH_* values)
        </Text>
        <Text>
          {"  "}3. Run <Text bold>pnpm cli</Text> again
        </Text>
      </Box>
      <Text dimColor>Press any key to exit.</Text>
    </Box>
  );
}
