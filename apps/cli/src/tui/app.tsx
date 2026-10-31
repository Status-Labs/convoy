import { readFileSync } from "node:fs";
import { useCallback, useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { Spinner } from "@inkjs/ui";
import {
  formatCost,
  formatRate,
  hourlyRate,
  monthToDateCost,
  newVmName,
  type Fleet,
  type FleetVm,
} from "@agent-platform/core";
import { saveLaunchPrefs, type LaunchPrefs } from "../prefs";
import { forgetHostKey, openShell, waitForCloudInit } from "../ssh";
import { Key } from "./key";
import { LaunchForm } from "./launch-form";

type Phase = "creating" | "booting" | "installing" | "ready" | "failed";

// A VM launched in this session, tracked through setup.
interface Job {
  name: string;
  phase: Phase;
  provider: string;
  region: string;
  vmId?: string;
}

interface Row {
  key: string;
  name: string;
  id?: string;
  vm?: FleetVm;
  job?: Job;
  deleting: boolean;
}

type Message = { text: string; tone: "info" | "success" | "error" } | null;

export interface AppProps {
  fleet: Fleet;
  launchPrefs: LaunchPrefs;
  sshKeyPath: string;
}

const REFRESH_MS = 10_000;
// Costs are computed locally from list prices, so they can tick between refreshes.
const COST_TICK_MS = 5_000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function age(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

export function App({ fleet, launchPrefs: initialPrefs, sshKeyPath }: AppProps) {
  const { exit, suspendTerminal } = useApp();
  const [list, setList] = useState<FleetVm[] | null>(null);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<Row | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [picking, setPicking] = useState(false);
  const [launchPrefs, setLaunchPrefs] = useState(initialPrefs);
  const summary = [
    fleet.clouds.map((c) => c.label).join(" + "),
    `next: ${fleet.cloud(launchPrefs.provider).label} ${launchPrefs.region} ${launchPrefs.size}`,
  ].join(" · ");
  const providerLabels = Object.fromEntries(fleet.clouds.map((c) => [c.name, c.label]));
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), COST_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { vms, errors } = await fleet.listVms();
      setList(vms.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      // Other providers' VMs still show when one is down.
      if (errors.length > 0) {
        const text = errors.map((e) => `${providerLabels[e.provider]}: ${e.message}`).join("; ");
        setMessage({ text: `Couldn't list some VMs. ${text}`, tone: "error" });
      }
    } catch (err) {
      setList((current) => current ?? []);
      setMessage({ text: errorText(err), tone: "error" });
    }
  }, [fleet]);

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

  async function launch(choice: LaunchPrefs) {
    setPicking(false);
    setLaunchPrefs(choice);
    saveLaunchPrefs(choice);
    let sshPublicKey: string;
    try {
      sshPublicKey = readFileSync(sshKeyPath, "utf8");
    } catch {
      setMessage({ text: `Can't read SSH public key at ${sshKeyPath}. Set SSH_PUBLIC_KEY_PATH in .env.`, tone: "error" });
      return;
    }

    const name = newVmName();
    updateJob(name, { phase: "creating", provider: choice.provider, region: choice.region });
    setSelected(0);
    setMessage(null);
    try {
      const { vms } = fleet.cloud(choice.provider);
      const created = await vms.launch({ sshPublicKey, name, ...choice });
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
      await fleet.cloud(row.vm?.provider ?? row.job!.provider).vms.provider.deleteVm(id);
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
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={2}>
        <Text bold color="cyan">
          agent-vm
        </Text>
        <Text dimColor>{summary}</Text>
      </Box>
      {list && list.length > 0 ? <CostSummary vms={list} now={now} /> : null}
    </Box>
  );

  if (picking) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        {header}
        <LaunchForm
          fleet={fleet}
          initial={launchPrefs}
          onLaunch={launch}
          onCancel={() => setPicking(false)}
        />
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
        <VmTable rows={rows} selected={current} providerLabels={providerLabels} now={now} />
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

const COLUMNS = { name: 18, status: 19, ip: 16, cloud: 14, region: 11, rate: 9, cost: 12 };

// Total rate and month-to-date cost of the listed VMs, from list prices.
function CostSummary({ vms, now }: { vms: FleetVm[]; now: Date }) {
  const running = vms.filter((vm) => vm.status === "running").length;
  const priced = vms.filter((vm) => vm.pricing);
  const rate = priced.reduce((sum, vm) => sum + (hourlyRate(vm) ?? 0), 0);
  const cost = priced.reduce((sum, vm) => sum + (monthToDateCost(vm, now) ?? 0), 0);
  const unpriced = vms.length - priced.length;
  return (
    <Text>
      {running} running · <Text bold>{formatRate(rate)}/hr</Text> · <Text bold>{formatCost(cost)}</Text> this month
      <Text dimColor> (est.{unpriced > 0 ? `, ${unpriced} without prices` : ""})</Text>
    </Text>
  );
}

interface VmTableProps {
  rows: Row[];
  selected: number;
  providerLabels: Record<string, string>;
  now: Date;
}

function VmTable({ rows, selected, providerLabels, now }: VmTableProps) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>
          {"  "}
          {"NAME".padEnd(COLUMNS.name)}
          {"STATUS".padEnd(COLUMNS.status)}
          {"IP".padEnd(COLUMNS.ip)}
          {"CLOUD".padEnd(COLUMNS.cloud)}
          {"REGION".padEnd(COLUMNS.region)}
          {"$/HR".padEnd(COLUMNS.rate)}
          {"THIS MONTH".padEnd(COLUMNS.cost)}
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
            <Box width={COLUMNS.cloud}>
              <Text>{providerLabels[row.vm?.provider ?? row.job?.provider ?? ""]}</Text>
            </Box>
            <Box width={COLUMNS.region}>
              <Text>{row.vm?.region ?? row.job?.region ?? ""}</Text>
            </Box>
            <Box width={COLUMNS.rate}>
              <CostCell value={row.vm ? hourlyRate(row.vm) : undefined} format={formatRate} />
            </Box>
            <Box width={COLUMNS.cost}>
              <CostCell value={row.vm ? monthToDateCost(row.vm, now) : undefined} format={formatCost} />
            </Box>
            <Text dimColor>{row.vm ? age(row.vm.createdAt) : ""}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

// undefined: not created yet; null: the provider has no prices.
function CostCell({ value, format }: { value: number | null | undefined; format: (n: number) => string }) {
  if (value === undefined) return <Text> </Text>;
  return value === null ? <Text dimColor>—</Text> : <Text>{format(value)}</Text>;
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
      // DigitalOcean keeps billing stopped VMs in full; only delete stops it.
      return row.vm.pricing && row.vm.pricing.stoppedHourly >= row.vm.pricing.hourly ? (
        <Text color="yellow">○ stopped, billed</Text>
      ) : (
        <Text dimColor>○ stopped</Text>
      );
    case "error":
      return <Text color="red">✗ error</Text>;
    default:
      return <Text dimColor>{row.vm?.providerStatus ?? ""}</Text>;
  }
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
          {"  "}2. Turn on at least one provider (see the list above)
        </Text>
        <Text>
          {"  "}3. Run <Text bold>pnpm cli</Text> again
        </Text>
      </Box>
      <Text dimColor>Press any key to exit.</Text>
    </Box>
  );
}
