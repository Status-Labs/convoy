import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { Spinner } from "@inkjs/ui";
import {
  DEFAULT_AUTOSLEEP_MINUTES,
  DESKTOP_USER,
  IDLE_CHECK_MS,
  formatMinutes,
  formatCost,
  formatRate,
  hourlyRate,
  monthToDateCost,
  newVmName,
  SIGN_IN_SCRIPT,
  type AgentKeys,
  type AgentVms,
  type Fleet,
  type FleetSnapshot,
  type FleetVm,
  type SignInMode,
  type Vm,
} from "@agent-platform/core";
import { afterSetup } from "../after-setup";
import { AutoSleeper } from "../autosleep";
import {
  loadAutosleep,
  loadProjectRepos,
  saveAutosleep,
  saveCurrentProject,
  saveLaunchPrefs,
  saveProjectRepos,
  type LaunchPrefs,
} from "../prefs";
import {
  desktopPassword,
  forgetHostKey,
  leaveTailnet,
  openDesktopTunnel,
  openInBrowser,
  openShell,
  openTmux,
  runInteractive,
  waitForCloudInit,
} from "../ssh";
import { Detail } from "./detail";
import { Key } from "./key";
import { LaunchForm } from "./launch-form";
import { ProjectPicker } from "./project-picker";
import { SnapshotList } from "./snapshots";

type Phase = "creating" | "booting" | "installing" | "ready" | "failed";

// A VM launched in this session, tracked through setup.
interface Job {
  name: string;
  phase: Phase;
  provider: string;
  region: string;
  project: string | null;
  vmId?: string;
  /** Setup's current phase on the VM, e.g. "adding Claude Code". */
  step?: string;
}

interface Row {
  key: string;
  name: string;
  id?: string;
  vm?: FleetVm;
  job?: Job;
  deleting: boolean;
  /** Sleep/wake step in progress. */
  busy?: string;
  /** Minutes of idleness before auto-sleep, if on. */
  autosleep?: number;
}

type Message = { text: string; tone: "info" | "success" | "error" } | null;

export interface AppProps {
  fleet: Fleet;
  launchPrefs: LaunchPrefs;
  sshKeyPath: string;
  keys: AgentKeys;
  projects: { projects: string[]; current: string | null };
}

const REFRESH_MS = 10_000;
const SNAPSHOT_REFRESH_MS = 30_000;
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

export function App({ fleet, launchPrefs: initialPrefs, sshKeyPath, keys, projects: initialProjects }: AppProps) {
  const { exit, suspendTerminal } = useApp();
  const [list, setList] = useState<FleetVm[] | null>(null);
  const [autosleep, setAutosleep] = useState(loadAutosleep);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<Row | null>(null);
  const [confirmSleep, setConfirmSleep] = useState<Row | null>(null);
  // Sleep/wake in progress, by VM name (waking can change the VM's id): the current step.
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<Message>(null);
  const [picking, setPicking] = useState(false);
  const [launchPrefs, setLaunchPrefs] = useState(initialPrefs);
  // null = all projects.
  const [project, setProject] = useState(initialProjects.current);
  const [savedProjects, setSavedProjects] = useState(initialProjects.projects);
  const [pickingProject, setPickingProject] = useState(false);
  const [view, setView] = useState<"vms" | "snapshots">("vms");
  const [snapshots, setSnapshots] = useState<FleetSnapshot[] | null>(null);
  const [deletingSnapshots, setDeletingSnapshots] = useState<Set<string>>(new Set());
  const [confirmSnapshot, setConfirmSnapshot] = useState<Row | null>(null);
  // The VM (by name: waking changes its id) whose detail view is open.
  const [detailName, setDetailName] = useState<string | null>(null);
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

  // Only while the Snapshots view is open, and less often than VMs.
  const refreshSnapshots = useCallback(async () => {
    try {
      const { snapshots: list, errors } = await fleet.listSnapshots();
      setSnapshots(list.filter((s) => project === null || s.project === project));
      if (errors.length > 0) {
        setMessage({ text: `Couldn't list some snapshots. ${errors.map((e) => `${e.provider}: ${e.message}`).join("; ")}`, tone: "error" });
      }
    } catch (err) {
      setSnapshots((current) => current ?? []);
      setMessage({ text: errorText(err), tone: "error" });
    }
  }, [fleet, project]);

  useEffect(() => {
    if (view !== "snapshots") return;
    void refreshSnapshots();
    const timer = setInterval(refreshSnapshots, SNAPSHOT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [view, refreshSnapshots]);

  const updateJob = (name: string, patch: Partial<Job>) =>
    setJobs((current) => ({ ...current, [name]: { name, phase: "creating", ...current[name], ...patch } as Job }));

  const inProject = (p: string | null) => project === null || p === project;
  // Newly launched VMs show up before the provider lists them.
  const listed = (list ?? []).filter((vm) => inProject(vm.project));
  const listedNames = new Set(listed.map((vm) => vm.name));
  const rows: Row[] = [
    ...Object.values(jobs)
      .filter((job) => inProject(job.project))
      .filter((job) => !listedNames.has(job.name) && (job.phase === "creating" || job.phase === "booting"))
      .map((job) => ({ key: job.name, name: job.name, id: job.vmId, job, deleting: false })),
    ...listed.map((vm) => ({
      key: vm.id,
      name: vm.name,
      id: vm.id,
      vm,
      job: jobs[vm.name],
      deleting: deleting.has(vm.id),
      busy: busy[vm.name],
      autosleep: autosleep[vm.name],
    })),
  ];
  const current = Math.min(selected, rows.length - 1);
  // Gone (deleted elsewhere) closes the detail view.
  const detailRow = detailName ? rows.find((r) => r.name === detailName && r.vm) : undefined;

  const setStep = (name: string, step: string | null) =>
    setBusy(({ [name]: _, ...rest }) => (step ? { ...rest, [name]: step } : rest));

  // Auto-sleep runs while the TUI is open, on VMs nothing else is doing.
  const latest = useRef({ list, busy, autosleep });
  latest.current = { list, busy, autosleep };
  useEffect(() => {
    const sleeper = new AutoSleeper(fleet, (event) => {
      if (event.kind === "sleeping") setStep(event.vm, "auto-sleeping");
      if (event.kind === "slept") {
        setStep(event.vm, null);
        setMessage({ text: `${event.vm} was idle, so it's asleep now. Press w to wake it.`, tone: "info" });
        void refresh();
      }
      if (event.kind === "error" && latest.current.busy[event.vm] === "auto-sleeping") {
        setStep(event.vm, null);
        setMessage({ text: `Couldn't auto-sleep ${event.vm}: ${event.message}`, tone: "error" });
      }
    });
    const timer = setInterval(() => {
      const { list: vms, busy: inProgress, autosleep: limits } = latest.current;
      if (vms && Object.keys(limits).length > 0) void sleeper.check(vms.filter((vm) => !inProgress[vm.name]), limits);
    }, IDLE_CHECK_MS);
    return () => clearInterval(timer);
  }, [fleet, refresh]);

  function toggleAutosleep(row: Row) {
    const vm = row.vm!;
    const minutes = row.autosleep ? null : DEFAULT_AUTOSLEEP_MINUTES;
    saveAutosleep(vm.name, minutes);
    setAutosleep(loadAutosleep());
    setMessage(
      minutes
        ? {
            text: `${vm.name} sleeps after ${formatMinutes(minutes)} idle (no SSH session, desktop viewer, agent tool, program in tmux or busy CPU), while this TUI is open. Change the time with: pnpm cli autosleep ${vm.name} 2h`,
            tone: "info",
          }
        : { text: `${vm.name} won't auto-sleep.`, tone: "info" },
    );
  }

  async function sleepVm(row: Row) {
    const vm = row.vm!;
    setStep(vm.name, "going to sleep");
    try {
      await fleet.cloud(vm.provider).vms.sleep(vm, (step) => setStep(vm.name, step));
      if (vm.publicIp) forgetHostKey(vm.publicIp);
      setMessage({ text: `${vm.name} is asleep. Press w to wake it.`, tone: "success" });
    } catch (err) {
      setMessage({ text: `Couldn't put ${vm.name} to sleep: ${errorText(err)}`, tone: "error" });
    } finally {
      setStep(vm.name, null);
      void refresh();
    }
  }

  async function wakeVm(row: Row) {
    const vm = row.vm!;
    let sshPublicKey: string;
    try {
      sshPublicKey = readFileSync(sshKeyPath, "utf8");
    } catch {
      setMessage({ text: `Can't read SSH public key at ${sshKeyPath}. Set SSH_PUBLIC_KEY_PATH in .env.`, tone: "error" });
      return;
    }
    setStep(vm.name, "waking");
    try {
      const woken = await fleet.cloud(vm.provider).vms.wake(vm, sshPublicKey);
      void refresh();
      // A new IP may have belonged to another machine before.
      forgetHostKey(woken.publicIp!);
      setStep(vm.name, "starting up");
      await waitForCloudInit(woken.publicIp!);
      setMessage({ text: `${vm.name} is awake at ${woken.publicIp}. Press enter to connect.`, tone: "success" });
    } catch (err) {
      setMessage({ text: `Couldn't wake ${vm.name}: ${errorText(err)}`, tone: "error" });
    } finally {
      setStep(vm.name, null);
      void refresh();
    }
  }

  async function launch(choice: LaunchPrefs, count: number) {
    setPicking(false);
    setLaunchPrefs(choice);
    saveLaunchPrefs(choice);
    setSelected(0);
    setMessage(null);
    for (let i = 0; i < count; i++) void launchOne(choice);
  }

  function launchOne(choice: LaunchPrefs) {
    return track({
      provider: choice.provider,
      region: choice.region,
      project,
      create: (vms, sshPublicKey, name) => vms.launch({ sshPublicKey, name, project: project ?? undefined, ...choice }),
      after: { mode: choice.signIn, tailscale: choice.tailscale },
      desktop: choice.desktop,
    });
  }

  // A copy of a snapshot, into the current project (else the snapshot's).
  function launchSnapshot(snapshot: FleetSnapshot) {
    const into = project ?? snapshot.project;
    setView("vms");
    setSelected(0);
    setMessage(null);
    return track({
      provider: snapshot.provider,
      region: snapshot.regions[0] ?? "",
      project: into,
      create: (vms, sshPublicKey, name) =>
        vms.launchFromSnapshot(snapshot, { sshPublicKey, name, project: into ?? undefined }),
      // Its tools are already signed in (or not) on the snapshot's disk.
      after: { mode: "subscription", tailscale: "if-installed" },
      desktop: false,
    });
  }

  // Launches one VM and follows it through setup in its row.
  async function track(launch: {
    provider: string;
    region: string;
    project: string | null;
    create: (vms: AgentVms, sshPublicKey: string, name: string) => Promise<Vm>;
    after: { mode: SignInMode; tailscale: boolean | "if-installed" };
    desktop: boolean;
  }) {
    let sshPublicKey: string;
    try {
      sshPublicKey = readFileSync(sshKeyPath, "utf8");
    } catch {
      setMessage({ text: `Can't read SSH public key at ${sshKeyPath}. Set SSH_PUBLIC_KEY_PATH in .env.`, tone: "error" });
      return;
    }

    const name = newVmName();
    updateJob(name, { phase: "creating", provider: launch.provider, region: launch.region, project: launch.project });
    try {
      const { vms } = fleet.cloud(launch.provider);
      const created = await launch.create(vms, sshPublicKey, name);
      updateJob(name, { phase: "booting", vmId: created.id });
      void refresh();
      const vm = await vms.waitForRunning(created.id);
      // A new IP may have belonged to another machine before.
      forgetHostKey(vm.publicIp!);
      updateJob(name, { phase: "installing" });
      void refresh();
      await waitForCloudInit(vm.publicIp!, { onPhase: (step) => updateJob(name, { step }) });
      updateJob(name, { step: "finishing up" });
      const { tailnetName, cloned, problems } = await afterSetup(vm.publicIp!, {
        name,
        keys,
        repos: loadProjectRepos(launch.project),
        ...launch.after,
      });
      updateJob(name, { phase: "ready", step: undefined });
      // Problems after setup leave a working VM; each has a command to retry it.
      if (problems.length > 0) {
        setMessage({ text: `${name} is ready, but ${problems.join("; ")}`, tone: "error" });
        return;
      }
      const newClones = cloned.filter((c) => c.status === "ok");
      const next = [
        newClones.length > 0 ? `Cloned ${newClones.length === 1 ? newClones[0]!.repo : `${newClones.length} repos`}` : null,
        launch.after.mode === "subscription" || (launch.after.tailscale === true && !keys.tailscale)
          ? "Select it and press l to sign in"
          : "Select it and press enter to connect",
        launch.desktop ? "Press g to open its desktop" : null,
        tailnetName ? `On your phone: ssh agent@${tailnetName}` : null,
      ];
      setMessage({ text: `${name} is ready. ${next.filter(Boolean).join(". ")}.`, tone: "success" });
    } catch (err) {
      updateJob(name, { phase: "failed", step: undefined });
      setMessage({ text: `${name}: ${errorText(err)}`, tone: "error" });
    }
  }

  async function snapshotVm(row: Row) {
    const vm = row.vm!;
    setStep(vm.name, "snapshotting");
    try {
      const snapshot = await fleet.cloud(vm.provider).vms.snapshot(vm, { onStep: (step) => setStep(vm.name, step) });
      if (vm.publicIp) {
        setStep(vm.name, "starting up");
        await waitForCloudInit(vm.publicIp);
      }
      setMessage({ text: `Saved ${snapshot.name} (${snapshot.sizeGb} GB). Press tab to see snapshots and launch copies.`, tone: "success" });
      void refreshSnapshots();
    } catch (err) {
      setMessage({ text: `Couldn't snapshot ${vm.name}: ${errorText(err)}`, tone: "error" });
    } finally {
      setStep(vm.name, null);
      void refresh();
    }
  }

  async function deleteSnapshot(snapshot: FleetSnapshot) {
    setDeletingSnapshots((current) => new Set(current).add(snapshot.id));
    try {
      await fleet.cloud(snapshot.provider).vms.provider.deleteSnapshot!(snapshot.id);
      setMessage({ text: `Deleted snapshot ${snapshot.name}.`, tone: "info" });
    } catch (err) {
      setMessage({ text: `Couldn't delete ${snapshot.name}: ${errorText(err)}`, tone: "error" });
    } finally {
      await refreshSnapshots();
      setDeletingSnapshots((current) => {
        const next = new Set(current);
        next.delete(snapshot.id);
        return next;
      });
    }
  }

  async function connect(row: Row, { tmux = false } = {}) {
    const ip = row.vm?.publicIp;
    if (!ip) {
      setMessage({ text: `${row.name} has no IP address yet.`, tone: "info" });
      return;
    }
    await suspendTerminal(async () => {
      if (tmux) {
        process.stdout.write(
          `Attaching to ${row.name}'s tmux session. Press Ctrl+B then D to come back; programs keep running.\n`,
        );
        await openTmux(ip);
      } else {
        process.stdout.write(`Connecting to ${row.name} (${ip}). Type "exit" to come back.\n`);
        await openShell(ip);
      }
    });
    void refresh();
  }

  async function signIn(row: Row) {
    const ip = row.vm?.publicIp;
    if (!ip) {
      setMessage({ text: `${row.name} has no IP address yet.`, tone: "info" });
      return;
    }
    await suspendTerminal(async () => {
      process.stdout.write(`Signing in agent tools on ${row.name} (${ip}).\n`);
      await runInteractive(ip, SIGN_IN_SCRIPT);
    });
  }

  async function openDesktop(row: Row) {
    const ip = row.vm?.publicIp;
    if (!ip) {
      setMessage({ text: `${row.name} has no IP address yet.`, tone: "info" });
      return;
    }
    setMessage({ text: `Opening ${row.name}'s desktop…`, tone: "info" });
    let password: string | null;
    try {
      password = await desktopPassword(ip);
    } catch (err) {
      setMessage({ text: `Couldn't open the desktop: ${errorText(err)}`, tone: "error" });
      return;
    }
    if (!password) {
      setMessage({ text: `${row.name} has no desktop. Add one: pnpm cli desktop ${row.name} --install`, tone: "info" });
      return;
    }
    await suspendTerminal(async () => {
      try {
        const tunnel = await openDesktopTunnel(ip);
        openInBrowser(tunnel.url);
        process.stdout.write(
          `${row.name}'s desktop is open at ${tunnel.url}\n  user: ${DESKTOP_USER}\n  password: ${password}\n\n` +
            `For your phone: pnpm cli desktop ${row.name} --phone\n`,
        );
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        await Promise.race([rl.question("Press enter to close the desktop and go back. "), tunnel.closed]);
        rl.close();
        tunnel.close();
      } catch (err) {
        process.stdout.write(`Couldn't open the desktop: ${errorText(err)}\n`);
      }
    });
    setMessage(null);
  }

  async function remove(row: Row) {
    const id = row.id!;
    setDeleting((current) => new Set(current).add(id));
    try {
      if (row.vm?.status === "running" && row.vm.publicIp) await leaveTailnet(row.vm.publicIp);
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
    if (confirmSleep) {
      if (input.toLowerCase() === "y") void sleepVm(confirmSleep);
      setConfirmSleep(null);
      return;
    }
    if (confirmSnapshot) {
      if (input.toLowerCase() === "y") void snapshotVm(confirmSnapshot);
      setConfirmSnapshot(null);
      return;
    }
    if (key.tab) {
      setMessage(null);
      return setView("snapshots");
    }

    if (input === "q" || key.escape) return exit();
    if (input === "n") return setPicking(true);
    if (input === "p") return setPickingProject(true);
    if (input === "r") {
      setMessage(null);
      return void refresh();
    }
    if (key.upArrow || input === "k") return setSelected(Math.max(0, current - 1));
    if (key.downArrow || input === "j") return setSelected(Math.min(rows.length - 1, current + 1));

    const row = rows[current];
    if (!row) return;
    if (row.busy) return setMessage({ text: `${row.name} is ${row.busy}…`, tone: "info" });
    const asleep = row.vm?.status === "asleep";
    if (asleep && (key.return || input === "l" || input === "g" || input === "t")) {
      return setMessage({ text: `${row.name} is asleep. Press w to wake it.`, tone: "info" });
    }
    if (key.rightArrow || input === "i") {
      if (!row.vm) return setMessage({ text: `${row.name} is still being created.`, tone: "info" });
      setMessage(null);
      return setDetailName(row.name);
    }
    if (key.return) return void connect(row);
    if (input === "t") return void connect(row, { tmux: true });
    if (input === "l") return void signIn(row);
    if (input === "g") return void openDesktop(row);
    if (input === "w") {
      if (!asleep) return setMessage({ text: `${row.name} isn't asleep.`, tone: "info" });
      return void wakeVm(row);
    }
    if (input === "s") {
      if (row.vm?.status !== "running") return setMessage({ text: `Only running VMs can sleep.`, tone: "info" });
      if (!fleet.cloud(row.vm.provider).vms.provider.sleepKind) {
        return setMessage({ text: `Sleep isn't supported on ${providerLabels[row.vm.provider]} yet.`, tone: "info" });
      }
      return setConfirmSleep(row);
    }
    if (input === "a") {
      if (!row.vm || row.vm.status === "asleep") return setMessage({ text: `Auto-sleep is for running VMs.`, tone: "info" });
      if (!fleet.cloud(row.vm.provider).vms.provider.sleepKind) {
        return setMessage({ text: `Sleep isn't supported on ${providerLabels[row.vm.provider]} yet.`, tone: "info" });
      }
      return toggleAutosleep(row);
    }
    if (input === "b") {
      if (row.vm?.status !== "running") return setMessage({ text: `Only running VMs can be snapshotted.`, tone: "info" });
      if (!fleet.cloud(row.vm.provider).vms.provider.snapshotVm) {
        return setMessage({ text: `Snapshots aren't supported on ${providerLabels[row.vm.provider]} yet.`, tone: "info" });
      }
      return setConfirmSnapshot(row);
    }
    if (input === "d") {
      if (!row.id) return setMessage({ text: `${row.name} is still being created.`, tone: "info" });
      if (!row.deleting) setConfirmDelete(row);
    }
  }, { isActive: !picking && !pickingProject && !detailRow && view === "vms" });

  const header = (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={2}>
        <Text bold color="cyan">
          agent-vm
        </Text>
        <Text bold>{project ?? "all projects"}</Text>
        <Text dimColor>{summary}</Text>
      </Box>
      {listed.length > 0 ? <CostSummary vms={listed} now={now} /> : null}
    </Box>
  );

  if (pickingProject) {
    const known = [...new Set([...savedProjects, ...(list ?? []).flatMap((vm) => (vm.project ? [vm.project] : []))])];
    const choose = (next: string | null) => {
      setProject(next);
      saveCurrentProject(next);
      setPickingProject(false);
      setSelected(0);
      setMessage(null);
    };
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        {header}
        <ProjectPicker
          projects={known.sort().map((name) => ({
            name,
            vms: (list ?? []).filter((vm) => vm.project === name).length,
          }))}
          totalVms={list?.length ?? 0}
          current={project}
          onPick={choose}
          onCreate={(name) => {
            setSavedProjects((current) => [...new Set([...current, name])]);
            choose(name);
          }}
          repos={loadProjectRepos}
          onSaveRepos={(name, repos) => {
            saveProjectRepos(name, repos);
            setSavedProjects((current) => [...new Set([...current, name])]);
          }}
          onCancel={() => setPickingProject(false)}
        />
      </Box>
    );
  }

  if (view === "snapshots") {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        {header}
        <SnapshotList
          snapshots={snapshots}
          providerLabels={providerLabels}
          deleting={deletingSnapshots}
          onLaunch={(snapshot) => void launchSnapshot(snapshot)}
          onDelete={(snapshot) => void deleteSnapshot(snapshot)}
          onRefresh={() => void refreshSnapshots()}
          onBack={() => setView("vms")}
          onQuit={exit}
        />
        {message ? (
          <Box marginTop={1}>
            <Text color={message.tone === "error" ? "red" : message.tone === "success" ? "green" : undefined}>
              {message.text}
            </Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (detailRow) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Detail
          key={detailRow.vm!.id}
          vm={detailRow.vm!}
          providerLabel={providerLabels[detailRow.vm!.provider] ?? detailRow.vm!.provider}
          now={now}
          onBack={() => setDetailName(null)}
          onConnect={() => void connect(detailRow)}
          onTmux={() => void connect(detailRow, { tmux: true })}
          onSignIn={() => void signIn(detailRow)}
          onDesktop={() => void openDesktop(detailRow)}
        />
        {message ? (
          <Box marginTop={1}>
            <Text color={message.tone === "error" ? "red" : message.tone === "success" ? "green" : undefined}>
              {message.text}
            </Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (picking) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        {header}
        <LaunchForm
          fleet={fleet}
          initial={launchPrefs}
          keys={keys}
          project={project}
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
          {project ? `No VMs in ${project} yet.` : "No agent VMs yet."} Press <Text bold color="cyan">n</Text> to launch
          one{savedProjects.length === 0 ? <>, or <Text bold color="cyan">p</Text> to create a project</> : null}.
        </Text>
      ) : (
        <VmTable
          rows={rows}
          selected={current}
          providerLabels={providerLabels}
          now={now}
          showProject={project === null}
        />
      )}

      <Box marginTop={1}>
        {confirmDelete ? (
          <Text color="yellow">
            Delete {confirmDelete.name}? This destroys the VM and everything on it. <Text bold>y/N</Text>
          </Text>
        ) : confirmSnapshot ? (
          <Text color="yellow">
            Snapshot {confirmSnapshot.name}? It shuts down for a few minutes while its disk is copied, then starts
            again. The snapshot includes everything on the disk, including signed-in credentials; storage is about
            $0.06/GB/month. <Text bold>y/N</Text>
          </Text>
        ) : confirmSleep ? (
          <SleepConfirm vm={confirmSleep.vm!} kind={fleet.cloud(confirmSleep.vm!.provider).vms.provider.sleepKind!} />
        ) : message ? (
          <Text color={message.tone === "error" ? "red" : message.tone === "success" ? "green" : undefined}>
            {message.tone === "error" ? "✗ " : message.tone === "success" ? "✓ " : ""}
            {message.text}
          </Text>
        ) : (
          <Text> </Text>
        )}
      </Box>

      <Box marginTop={1} columnGap={2} flexWrap="wrap">
        <Key k="n" label="new" />
        <Key k="⏎" label="connect" />
        <Key k="t" label="tmux" />
        <Key k="i" label="details" />
        <Key k="l" label="sign in" />
        <Key k="g" label="desktop" />
        <Key k="s" label="sleep" />
        <Key k="w" label="wake" />
        <Key k="a" label="auto-sleep" />
        <Key k="b" label="snapshot" />
        <Key k="d" label="delete" />
        <Key k="p" label="project" />
        <Key k="tab" label="snapshots" />
        <Key k="q" label="quit" />
      </Box>
    </Box>
  );
}

// Fits 110 columns with the project column (all-projects view).
const COLUMNS = { name: 16, project: 10, status: 20, ip: 16, cloud: 13, region: 10, rate: 7, cost: 11 };

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
  /** In the all-projects view. */
  showProject: boolean;
}

function VmTable({ rows, selected, providerLabels, now, showProject }: VmTableProps) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>
          {"  "}
          {"NAME".padEnd(COLUMNS.name)}
          {showProject ? "PROJECT".padEnd(COLUMNS.project) : ""}
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
            {showProject && (
              <Box width={COLUMNS.project}>
                <Text wrap="truncate" dimColor={!(row.vm?.project ?? row.job?.project)}>
                  {row.vm?.project ?? row.job?.project ?? "—"}
                </Text>
              </Box>
            )}
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
              <Text wrap="truncate">{row.vm?.region ?? row.job?.region ?? ""}</Text>
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

function SleepConfirm({ vm, kind }: { vm: FleetVm; kind: "snapshot" | "stop" }) {
  const now = vm.pricing ? `${formatRate(vm.pricing.hourly)}/hr` : "its running price";
  return kind === "snapshot" ? (
    <Box flexDirection="column">
      <Text color="yellow">
        Put {vm.name} to sleep? It's shut down, snapshotted and deleted until you wake it: {now} becomes $0.06 per GB
        of disk in use per month.
      </Text>
      <Text color="yellow">
        Sleeping and waking each take a minute or two (longer for big disks); it gets a new IP. Running programs
        stop. The snapshot includes everything on the disk, including signed-in credentials. <Text bold>y/N</Text>
      </Text>
    </Box>
  ) : (
    <Text color="yellow">
      Put {vm.name} to sleep? It's stopped until you wake it, and you pay only for its disk
      {vm.pricing ? ` (${formatRate(vm.pricing.stoppedHourly)}/hr)` : ""}. It gets a new IP when it wakes. Running
      programs stop. <Text bold>y/N</Text>
    </Text>
  );
}

// A spinner whose label is cut to the column instead of wrapping.
function Busy({ label }: { label: string }) {
  return (
    <Box gap={1}>
      <Spinner />
      <Text wrap="truncate-end">{label}</Text>
    </Box>
  );
}

function StatusCell({ row }: { row: Row }) {
  if (row.deleting) return <Spinner label="deleting" />;
  if (row.busy) return <Spinner label={row.busy} />;

  const phase = row.job?.phase;
  if (phase === "installing" && row.job?.step) return <Busy label={row.job.step} />;
  if (phase === "creating" || phase === "booting" || phase === "installing") {
    return <Spinner label={PHASE_LABELS[phase]} />;
  }
  if (phase === "ready") return <Text color="green">● ready</Text>;
  if (phase === "failed") return <Text color="red">✗ {PHASE_LABELS.failed}</Text>;

  switch (row.vm?.status) {
    case "running":
      return (
        <Text>
          <Text color="green">● running</Text>
          {row.autosleep ? <Text dimColor>{` ☾${formatMinutes(row.autosleep)}`}</Text> : null}
        </Text>
      );
    case "provisioning":
      return <Spinner label="starting" />;
    case "asleep":
      return <Text color="blue">☾ asleep</Text>;
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
