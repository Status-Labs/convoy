import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { Spinner, TextInput } from "@inkjs/ui";
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
  SETUP_VERSION,
  SIGN_IN_SCRIPT,
  updateMessage,
  updateStatus,
  type AgentKeys,
  type AgentVms,
  type Fleet,
  type FleetSnapshot,
  type FleetVm,
  snapshotsTakenFrom,
  type SignInMode,
  type Vm,
} from "@convoy/core";
import { afterSetup } from "../after-setup";
import { AutoSleeper } from "../autosleep";
import {
  loadAutosleep,
  loadProjectRepos,
  removeProject,
  saveAutosleep,
  saveCurrentProject,
  saveLaunchPrefs,
  saveProjectRepos,
  type LaunchPrefs,
} from "../prefs";
import {
  checkUpdate,
  desktopPassword,
  forgetHostKey,
  leaveTailnet,
  openDesktopTunnel,
  openInBrowser,
  openShell,
  openTmux,
  runInteractive,
  updateVm,
  waitForCloudInit,
} from "../ssh";
import { Detail } from "./detail";
import { Help } from "./help";
import { Inspector } from "./inspector";
import { LaunchForm } from "./launch-form";
import { ProjectPicker } from "./project-picker";
import { Projects, type ProjectSummary } from "./projects";
import { SnapshotList } from "./snapshots";
import {
  Header,
  KeyBar,
  MessageLine,
  Modal,
  ProgressLine,
  Rule,
  TABS,
  WIDE_COLUMNS,
  type KeyHint,
  type Message,
  type Tab,
  type Tone,
} from "./ui";
import { groupRows, needsUpdate, rowActivity, rowProject, rowTone, VmList, type Job, type Row } from "./vm-list";

export interface AppProps {
  fleet: Fleet;
  launchPrefs: LaunchPrefs;
  sshKeyPath: string;
  keys: AgentKeys;
  projects: { projects: string[]; current: string | null };
}

type Overlay =
  | { kind: "launch" }
  | { kind: "help" }
  | { kind: "project" }
  | { kind: "delete"; row: Row; snapshots: FleetSnapshot[] | null; error?: string }
  | { kind: "sleep"; row: Row }
  | { kind: "snapshot"; row: Row }
  | { kind: "update"; row: Row }
  | null;

const REFRESH_MS = 10_000;
// How often to re-read each running VM's setup version.
const UPDATE_CHECK_MS = 10 * 60_000;
const SNAPSHOT_REFRESH_MS = 30_000;
// Costs are computed locally from list prices, so they can tick between refreshes.
const COST_TICK_MS = 5_000;
const INSPECTOR_WIDTH = 46;
const HOURS_PER_MONTH = 730;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function App({ fleet, launchPrefs: initialPrefs, sshKeyPath, keys, projects: initialProjects }: AppProps) {
  const { exit, suspendTerminal } = useApp();
  const { columns, rows: terminalRows } = useWindowSize();
  const [list, setList] = useState<FleetVm[] | null>(null);
  const [allSnapshots, setAllSnapshots] = useState<FleetSnapshot[] | null>(null);
  const [autosleep, setAutosleep] = useState(loadAutosleep);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  // By name: rows reorder as they're grouped, and a launch's row changes key when the provider lists it.
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("vms");
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [inspectorOn, setInspectorOn] = useState(true);
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [projectsEditing, setProjectsEditing] = useState(false);
  const [snapshotConfirming, setSnapshotConfirming] = useState(false);
  const [snapshotCursor, setSnapshotCursor] = useState<FleetSnapshot | undefined>(undefined);
  // Sleep/wake in progress, by VM name (waking can change the VM's id): the current step.
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<Message>(null);
  const [launchPrefs, setLaunchPrefs] = useState(initialPrefs);
  // null = all projects.
  const [project, setProject] = useState(initialProjects.current);
  const [savedProjects, setSavedProjects] = useState(initialProjects.projects);
  const [deletingSnapshots, setDeletingSnapshots] = useState<Set<string>>(new Set());
  // The VM (by name: waking changes its id) whose full-screen details are open.
  const [detailName, setDetailName] = useState<string | null>(null);
  const providerLabels = Object.fromEntries(fleet.clouds.map((c) => [c.name, c.label]));
  const [now, setNow] = useState(() => new Date());
  // Setup version checks by VM id (an IP can be reused), read in the background.
  const [updates, setUpdates] = useState<Record<string, NonNullable<Row["update"]> & { at: number }>>({});
  const checking = useRef(new Set<string>());
  const announced = useRef(new Set<string>());

  const inner = Math.max(40, columns - 2);
  // The frame fills the terminal (less one line, so Ink doesn't scroll) and every part has a
  // fixed height, so the rules don't move as data loads: header + rule, the body, then
  // rule + two status lines + the key bar.
  const frameHeight = Math.max(16, terminalRows - 1);
  const bodyHeight = frameHeight - 7;
  const wide = columns >= WIDE_COLUMNS;
  const showInspector = wide && inspectorOn;

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

  // The inspector and tab counts use snapshots too, so they load in the background.
  const lastSnapshotError = useRef("");
  const refreshSnapshots = useCallback(async () => {
    try {
      const { snapshots: found, errors } = await fleet.listSnapshots();
      setAllSnapshots(found);
      // This runs every 30s on every tab, so the same error is shown once, not over newer messages.
      const text = errors.map((e) => `${providerLabels[e.provider] ?? e.provider}: ${e.message}`).join("; ");
      if (text && text !== lastSnapshotError.current) {
        setMessage({ text: `Couldn't list some snapshots. ${text}`, tone: "error" });
      }
      lastSnapshotError.current = text;
    } catch (err) {
      setAllSnapshots((current) => current ?? []);
      const text = errorText(err);
      if (text !== lastSnapshotError.current) setMessage({ text: `Couldn't list snapshots. ${text}`, tone: "error" });
      lastSnapshotError.current = text;
    }
  }, [fleet]);

  useEffect(() => {
    void refreshSnapshots();
    const timer = setInterval(refreshSnapshots, SNAPSHOT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshSnapshots]);

  const checkVersion = useCallback(async (vm: FleetVm) => {
    if (!vm.publicIp || checking.current.has(vm.id)) return;
    checking.current.add(vm.id);
    try {
      const { version, rebootRequired } = await checkUpdate(vm.publicIp);
      const status = updateStatus(version);
      setUpdates((current) => ({ ...current, [vm.id]: { status, rebootRequired, at: Date.now() } }));
      const text = updateMessage(vm.name, status);
      // Said once per VM per session; the list keeps showing it.
      if (text && status.state !== "newer" && !announced.current.has(vm.id)) {
        announced.current.add(vm.id);
        setMessage((current) => current ?? { text: `${text} Select it and press u.`, tone: status.state === "security" ? "error" : "info" });
      }
    } catch {
      // Unreachable or still setting up: try again on a later refresh.
    } finally {
      checking.current.delete(vm.id);
    }
  }, []);

  useEffect(() => {
    for (const vm of list ?? []) {
      if (vm.status !== "running" || busy[vm.name] || jobs[vm.name]?.phase === "installing") continue;
      const last = updates[vm.id];
      if (!last || Date.now() - last.at > UPDATE_CHECK_MS) void checkVersion(vm);
    }
    // Re-checked on each listing (every REFRESH_MS); UPDATE_CHECK_MS limits the SSH calls.
  }, [list]);

  const updateJob = (name: string, patch: Partial<Job>) =>
    setJobs((current) => ({ ...current, [name]: { name, phase: "creating", ...current[name], ...patch } as Job }));

  // Every VM and launch, in any project: the progress line and Projects tab use them all.
  const listedNames = new Set((list ?? []).map((vm) => vm.name));
  const allRows: Row[] = [
    ...Object.values(jobs)
      .filter((job) => !listedNames.has(job.name) && (job.phase === "creating" || job.phase === "booting"))
      .map((job) => ({ key: job.name, name: job.name, id: job.vmId, job, deleting: false })),
    ...(list ?? []).map((vm) => ({
      key: vm.id,
      name: vm.name,
      id: vm.id,
      vm,
      job: jobs[vm.name],
      deleting: deleting.has(vm.id),
      busy: busy[vm.name],
      autosleep: autosleep[vm.name],
      update: vm.status === "running" ? updates[vm.id] : undefined,
    })),
  ];
  const inProject = (p: string | null) => project === null || p === project;
  const projectRows = allRows.filter((row) => inProject(rowProject(row)));
  const rows = filter ? projectRows.filter((row) => row.name.toLowerCase().includes(filter.toLowerCase())) : projectRows;
  const grouped = project === null && new Set(rows.map(rowProject)).size > 1;
  const ordered = grouped ? groupRows(rows).flatMap((g) => g.rows) : rows;
  const selectedIndex = Math.max(0, ordered.findIndex((r) => r.name === selectedName));
  const selected = ordered[selectedIndex];
  // Gone (deleted elsewhere) closes the details.
  const detailRow = detailName ? allRows.find((r) => r.name === detailName && r.vm) : undefined;
  const tabSnapshots = allSnapshots?.filter((s) => project === null || s.project === project || s.untagged) ?? null;
  // The same matching delete uses, so the inspector's count is what `d` would remove.
  const snapshotsOf = (row: Row | undefined) =>
    !row?.vm || allSnapshots === null
      ? null
      : snapshotsTakenFrom(
          row.vm,
          allSnapshots.filter((s) => s.provider === row.vm!.provider),
          (list ?? []).filter((vm) => vm.provider === row.vm!.provider),
        );

  const knownProjects = [...new Set([...savedProjects, ...(list ?? []).flatMap((vm) => (vm.project ? [vm.project] : []))])].sort();
  const projectSummaries: ProjectSummary[] = knownProjects.map((name) => {
    const inIt = allRows.filter((row) => rowProject(row) === name);
    const tones: Partial<Record<Tone, number>> = {};
    for (const row of inIt) tones[rowTone(row)] = (tones[rowTone(row)] ?? 0) + 1;
    return {
      name,
      tones,
      repos: loadProjectRepos(name),
      cost: inIt.reduce((sum, row) => sum + (row.vm ? (monthToDateCost(row.vm, now) ?? 0) : 0), 0),
    };
  });

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
        setMessage({ text: `${event.vm} was idle, so it's asleep now. Press s to wake it.`, tone: "info" });
        void refresh();
      }
      if (event.kind === "error" && latest.current.busy[event.vm] === "auto-sleeping") {
        setStep(event.vm, null);
        setMessage({ text: `Couldn't auto-sleep ${event.vm}: ${event.message}`, tone: "error" });
      }
    });
    const timer = setInterval(() => {
      // Re-read the settings each time: `pnpm cli autosleep` or another TUI may have changed them.
      const limits = loadAutosleep();
      if (JSON.stringify(limits) !== JSON.stringify(latest.current.autosleep)) setAutosleep(limits);
      const { list: vms, busy: inProgress } = latest.current;
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
      // Listings lag a few seconds behind; until then the VM would show as stopped.
      setStep(vm.name, "finishing");
      for (let i = 0; i < 10; i++) {
        const { vms } = await fleet.listVms();
        if (vms.some((v) => v.name === vm.name && v.status === "asleep")) break;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      setMessage({ text: `${vm.name} is asleep. Press s to wake it.`, tone: "success" });
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
    setLaunchPrefs(choice);
    saveLaunchPrefs(choice);
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
    setTab("vms");
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
      setMessage({ text: `Saved ${snapshot.name} (${snapshot.sizeGb} GB). Press 2 to see snapshots and launch copies.`, tone: "success" });
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

  async function updateSetup(row: Row) {
    const vm = row.vm!;
    const ip = vm.publicIp;
    if (!ip) return;
    let code = 1;
    await suspendTerminal(async () => {
      process.stdout.write(`Updating ${vm.name} to Convoy setup v${SETUP_VERSION}. Agents and SSH sessions keep running.\n\n`);
      code = await updateVm(ip);
      process.stdout.write(code === 0 ? `\n${vm.name} is up to date.\n` : `\nThe update failed (exit ${code}). It's safe to run again.\n`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await rl.question("Press enter to go back. ");
      rl.close();
    });
    setUpdates(({ [vm.id]: _, ...rest }) => rest);
    await checkVersion(vm);
    setMessage(
      code === 0
        ? { text: `${vm.name} is on setup v${SETUP_VERSION}.`, tone: "success" }
        : { text: `Updating ${vm.name} failed. Press u to retry, or run: pnpm cli update ${vm.name} --force`, tone: "error" },
    );
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

  // Snapshots were listed before the VM goes, while its name was still known to be its own.
  async function remove(row: Row, snapshots: FleetSnapshot[]) {
    const id = row.id!;
    setDeleting((current) => new Set(current).add(id));
    try {
      if (row.vm?.status === "running" && row.vm.publicIp) await leaveTailnet(row.vm.publicIp);
      await fleet.cloud(row.vm?.provider ?? row.job!.provider).vms.provider.deleteVm(id);
      if (row.vm?.publicIp) forgetHostKey(row.vm.publicIp);
      setJobs(({ [row.name]: _, ...rest }) => rest);
      const failed = await fleet.deleteSnapshots(snapshots);
      const gone = snapshots.length - failed.length;
      const deleted = `Deleted ${row.name}${gone > 0 ? ` and ${gone} snapshot${gone === 1 ? "" : "s"}` : ""}.`;
      setMessage(
        failed.length > 0
          ? { text: `${deleted} Couldn't delete ${failed.map((f) => `${f.snapshot.name} (${f.message})`).join(", ")}.`, tone: "error" }
          : { text: deleted, tone: "info" },
      );
      void refresh();
      void refreshSnapshots();
    } catch (err) {
      setDeleting((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      setMessage({ text: `Couldn't delete ${row.name}: ${errorText(err)}`, tone: "error" });
    }
  }


  function chooseProject(next: string | null) {
    setProject(next);
    saveCurrentProject(next);
    setSelectedName(null);
    setMessage(null);
  }

  async function askDelete(row: Row) {
    setOverlay({ kind: "delete", row, snapshots: row.vm ? null : [] });
    if (!row.vm) return;
    try {
      const snapshots = await fleet.snapshotsOf(row.vm);
      setOverlay((o) => (o?.kind === "delete" && o.row === row ? { ...o, snapshots } : o));
    } catch (err) {
      setOverlay((o) => (o?.kind === "delete" && o.row === row ? { ...o, snapshots: [], error: errorText(err) } : o));
    }
  }

  const sleepSupported = (vm: FleetVm) => Boolean(fleet.cloud(vm.provider).vms.provider.sleepKind);
  const snapshotSupported = (vm: FleetVm) => Boolean(fleet.cloud(vm.provider).vms.provider.snapshotVm);

  function vmKeys(row: Row | undefined): KeyHint[] {
    if (!row || rowActivity(row)) return [];
    const vm = row.vm;
    if (vm?.status === "running") {
      return [
        ["⏎", "connect"],
        ["t", "tmux"],
        ["g", "desktop"],
        ["l", "sign-in"],
        ...(sleepSupported(vm) ? ([["s", "sleep"], ["a", row.autosleep ? "auto-sleep off" : "auto-sleep"]] as KeyHint[]) : []),
        ...(snapshotSupported(vm) ? ([["b", "snapshot"]] as KeyHint[]) : []),
        ...(needsUpdate(row) ? ([["u", "update"]] as KeyHint[]) : []),
        ["d", "delete"],
      ];
    }
    if (vm?.status === "asleep") return [["s", "wake"], ["d", "delete"]];
    return row.id ? [["d", "delete"]] : [];
  }

  // App-wide keys: tabs, help, quit, project switcher.
  useInput(
    (input, key) => {
      if (input === "?") return setOverlay({ kind: "help" });
      if (input === "q") return exit();
      const byKey = TABS.find((t) => t.key === input);
      if (byKey) return (setTab(byKey.id), setMessage(null));
      if (key.tab) {
        const next = TABS[(TABS.findIndex((t) => t.id === tab) + 1) % TABS.length]!;
        return (setTab(next.id), setMessage(null));
      }
      if (input === "p") return setOverlay({ kind: "project" });
      if (input === "r") {
        setMessage(null);
        void refresh();
        return void refreshSnapshots();
      }
      if (key.escape) {
        if (tab !== "vms") return setTab("vms");
        if (filter) return setFilter("");
        return setMessage(null);
      }
      if (tab !== "vms") return;

      if (input === "n") return setOverlay({ kind: "launch" });
      if (input === "N") {
        setMessage({
          text: `Launching like last time: ${providerLabels[launchPrefs.provider]} ${launchPrefs.region} ${launchPrefs.size}.`,
          tone: "info",
        });
        return void launchOne(launchPrefs);
      }
      if (input === "/") return setFiltering(true);
      if (input === "i") {
        if (wide) return setInspectorOn((on) => !on);
        if (selected?.vm) return setDetailName(selected.name);
        return;
      }
      if (key.upArrow || input === "k") return setSelectedName(ordered[Math.max(0, selectedIndex - 1)]?.name ?? null);
      if (key.downArrow || input === "j") return setSelectedName(ordered[Math.min(ordered.length - 1, selectedIndex + 1)]?.name ?? null);

      const row = selected;
      if (!row) return;
      const activity = rowActivity(row);
      if (activity) return setMessage({ text: `${row.name} is ${activity}…`, tone: "info" });
      const vm = row.vm;
      const asleep = vm?.status === "asleep";
      const running = vm?.status === "running";
      if (input === "d") {
        if (!row.id) return setMessage({ text: `${row.name} is still being created.`, tone: "info" });
        return void askDelete(row);
      }
      if (input === "s" || input === "w") {
        if (asleep) return void wakeVm(row);
        if (input === "w") return setMessage({ text: `${row.name} isn't asleep.`, tone: "info" });
        if (!running) return setMessage({ text: `Only running VMs can sleep.`, tone: "info" });
        if (!sleepSupported(vm)) return setMessage({ text: `Sleep isn't supported on ${providerLabels[vm.provider]} yet.`, tone: "info" });
        return setOverlay({ kind: "sleep", row });
      }
      if (asleep && (key.return || ["l", "g", "t", "b", "a", "u"].includes(input) || key.rightArrow)) {
        return setMessage({ text: `${row.name} is asleep. Press s to wake it.`, tone: "info" });
      }
      if (!vm) return setMessage({ text: `${row.name} is still being created.`, tone: "info" });
      if (key.rightArrow) return (setMessage(null), setDetailName(row.name));
      if (key.return) return void connect(row);
      if (input === "t") return void connect(row, { tmux: true });
      if (input === "l") return void signIn(row);
      if (input === "g") return void openDesktop(row);
      if (input === "a") {
        if (!running) return setMessage({ text: `Auto-sleep is for running VMs.`, tone: "info" });
        if (!sleepSupported(vm)) return setMessage({ text: `Sleep isn't supported on ${providerLabels[vm.provider]} yet.`, tone: "info" });
        return toggleAutosleep(row);
      }
      if (input === "u") {
        if (!running) return setMessage({ text: `Only running VMs can be updated.`, tone: "info" });
        const status = row.update?.status;
        if (status?.state === "newer") return setMessage({ text: updateMessage(row.name, status)!, tone: "info" });
        return setOverlay({ kind: "update", row });
      }
      if (input === "b") {
        if (!running) return setMessage({ text: `Only running VMs can be snapshotted.`, tone: "info" });
        if (!snapshotSupported(vm)) return setMessage({ text: `Snapshots aren't supported on ${providerLabels[vm.provider]} yet.`, tone: "info" });
        return setOverlay({ kind: "snapshot", row });
      }
    },
    { isActive: overlay === null && !detailRow && !filtering && !projectsEditing && !snapshotConfirming },
  );

  // Questions answered with one key.
  useInput(
    (input, key) => {
      if (!overlay || !("row" in overlay)) return;
      const yes = input.toLowerCase() === "y";
      if (overlay.kind === "delete") {
        if (overlay.snapshots === null && !key.escape) return; // still checking
        if (yes) void remove(overlay.row, overlay.snapshots ?? []);
        else if (input === "k" && overlay.snapshots && overlay.snapshots.length > 0) void remove(overlay.row, []);
      }
      if (overlay.kind === "sleep" && yes) void sleepVm(overlay.row);
      if (overlay.kind === "snapshot" && yes) void snapshotVm(overlay.row);
      if (overlay.kind === "update" && yes) void updateSetup(overlay.row);
      setOverlay(null);
    },
    { isActive: overlay !== null && "row" in overlay },
  );

  useInput(
    (_input, key) => {
      if (key.escape) {
        setFilter("");
        setFiltering(false);
      }
    },
    { isActive: filtering },
  );

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
        <Box marginTop={1}>
          <MessageLine message={message} />
        </Box>
      </Box>
    );
  }

  const priced = projectRows.filter((row) => row.vm?.pricing);
  const rate = priced.reduce((sum, row) => sum + (hourlyRate(row.vm!) ?? 0), 0);
  const cost = priced.reduce((sum, row) => sum + (monthToDateCost(row.vm!, now) ?? 0), 0);
  const storage = (tabSnapshots ?? []).reduce((sum, s) => sum + (s.monthly ?? 0), 0);
  const headerRight =
    tab === "snapshots" ? (
      <Text>
        <Text dimColor>{tabSnapshots?.length ?? 0} saved · </Text>
        <Text bold>{formatCost(storage)}/mo</Text>
        <Text dimColor> storage</Text>
      </Text>
    ) : wide ? (
      <Text>
        <Text dimColor>{project ?? "all projects"} · </Text>
        <Text bold>{formatRate(rate)}/hr</Text>
        <Text dimColor> · </Text>
        <Text bold>{formatCost(cost)}</Text>
        <Text dimColor> this month</Text>
      </Text>
    ) : (
      <Text bold>{formatRate(rate)}/hr</Text>
    );

  const progress = allRows.flatMap((row) => {
    const step = rowActivity(row);
    return step ? [{ name: row.name, step }] : [];
  });

  let bar: { local: KeyHint[]; global: KeyHint[] };
  if (tab === "snapshots") {
    bar = {
      local: snapshotCursor ? [...(snapshotCursor.untagged ? [] : ([["⏎", "launch copy"]] as KeyHint[])), ["d", "delete"]] : [],
      global: [["r", "refresh"], ["1", "VMs"], ["?", "help"]],
    };
  } else if (tab === "projects") {
    bar = {
      local: [["⏎", "show only this"], ["e", "edit repos"], ["n", "new project"], ["d", "delete"]],
      global: [["a", "show all"], ["?", "help"]],
    };
  } else if (wide) {
    bar = { local: vmKeys(selected), global: [["n", "new"], ["?", "help"]] };
  } else {
    bar = {
      local: [...vmKeys(selected).filter(([k]) => ["⏎", "s", "d"].includes(k)), ...(selected?.vm ? ([["i", "inspect"]] as KeyHint[]) : [])],
      global: [["n", "new"], ["?", "all keys"]],
    };
  }

  let content;
  if (overlay?.kind === "launch") {
    content = (
      <LaunchForm
        fleet={fleet}
        initial={launchPrefs}
        keys={keys}
        project={project}
        repos={loadProjectRepos(project)}
        onLaunch={(choice, count) => {
          setOverlay(null);
          void launch(choice, count);
        }}
        onCancel={() => setOverlay(null)}
      />
    );
  } else if (overlay?.kind === "help") {
    content = <Help onClose={() => setOverlay(null)} />;
  } else if (overlay?.kind === "project") {
    content = (
      <ProjectPicker
        projects={knownProjects.map((name) => ({ name, vms: (list ?? []).filter((vm) => vm.project === name).length }))}
        totalVms={list?.length ?? 0}
        current={project}
        onPick={(next) => {
          chooseProject(next);
          setOverlay(null);
        }}
        onCreate={(name) => {
          setSavedProjects((current) => [...new Set([...current, name])]);
          chooseProject(name);
          setOverlay(null);
        }}
        repos={loadProjectRepos}
        onSaveRepos={(name, repos) => {
          saveProjectRepos(name, repos);
          setSavedProjects((current) => [...new Set([...current, name])]);
        }}
        onCancel={() => setOverlay(null)}
      />
    );
  } else if (overlay?.kind === "delete") {
    content = <DeleteConfirm row={overlay.row} snapshots={overlay.snapshots} error={overlay.error} />;
  } else if (overlay?.kind === "sleep") {
    content = (
      <Modal title={`Put ${overlay.row.name} to sleep?`} tone="yellow" width={84}>
        <SleepConfirm vm={overlay.row.vm!} kind={fleet.cloud(overlay.row.vm!.provider).vms.provider.sleepKind!} />
        <Box marginTop={1}>
          <KeyBar local={[["y", "sleep"], ["esc", "cancel"]]} global={[]} />
        </Box>
      </Modal>
    );
  } else if (overlay?.kind === "snapshot") {
    content = (
      <Modal title={`Snapshot ${overlay.row.name}?`} tone="yellow" width={84}>
        <Text>
          It shuts down for a few minutes while its disk is copied, then starts again. The snapshot includes everything on
          the disk, including signed-in credentials. Storage is about $0.06/GB/month.
        </Text>
        <Box marginTop={1}>
          <KeyBar local={[["y", "snapshot"], ["esc", "cancel"]]} global={[]} />
        </Box>
      </Modal>
    );
  } else if (overlay?.kind === "update") {
    const status = overlay.row.update?.status;
    const current = status?.state === "current";
    content = (
      <Modal title={`Update ${overlay.row.name}?`} tone={status?.state === "security" ? "red" : "yellow"} width={84}>
        <Text>
          {status
            ? current
              ? `It's already on setup v${status.version}. Running the update again repairs anything that drifted.`
              : `From setup v${status.version} to v${SETUP_VERSION}:`
            : `Brings it to setup v${SETUP_VERSION}.`}
        </Text>
        {status && !current
          ? status.notes.map((note) => (
              <Text key={note}>
                {"  "}- {note}
              </Text>
            ))
          : null}
        <Box marginTop={1}>
          <Text dimColor>
            Re-applies the security baseline and updates Node.js, the CLIs and agent tools over SSH. Agents and SSH
            sessions keep running; nothing reboots.
          </Text>
        </Box>
        <Box marginTop={1}>
          <KeyBar local={[["y", "update"], ["esc", "cancel"]]} global={[]} />
        </Box>
      </Modal>
    );
  } else if (tab === "snapshots") {
    content = (
      <SnapshotList
        snapshots={tabSnapshots}
        providerLabels={providerLabels}
        deleting={deletingSnapshots}
        onLaunch={(snapshot) => void launchSnapshot(snapshot)}
        onDelete={(snapshot) => void deleteSnapshot(snapshot)}
        onCursor={setSnapshotCursor}
        onConfirming={setSnapshotConfirming}
        active
      />
    );
  } else if (tab === "projects") {
    content = (
      <Projects
        projects={projectSummaries}
        current={project}
        width={inner}
        onShow={(next) => {
          chooseProject(next);
          if (next) setTab("vms");
        }}
        onCreate={(name) => {
          saveProjectRepos(name, loadProjectRepos(name));
          setSavedProjects((current) => [...new Set([...current, name])]);
        }}
        onSaveRepos={(name, repos) => {
          saveProjectRepos(name, repos);
          setSavedProjects((current) => [...new Set([...current, name])]);
        }}
        onDelete={(name) => {
          removeProject(name);
          setSavedProjects((current) => current.filter((p) => p !== name));
          if (project === name) setProject(null);
          setMessage({ text: `Forgot project ${name}.`, tone: "info" });
        }}
        onEditing={setProjectsEditing}
      />
    );
  } else if (list === null) {
    content = <Spinner label="Loading VMs…" />;
  } else if (rows.length === 0) {
    content = filter ? (
      <Text>
        No VMs match “{filter}”. <Text dimColor>esc clears the filter.</Text>
      </Text>
    ) : (
      <Text>
        {project ? `No VMs in ${project} yet.` : "No VMs yet."} Press <Text bold color="cyan">n</Text> to launch one
        {knownProjects.length === 0 ? (
          <>
            , or <Text bold color="cyan">3</Text> to set up a project
          </>
        ) : null}
        .
      </Text>
    );
  } else {
    const listWidth = showInspector ? inner - INSPECTOR_WIDTH - 2 : inner;
    content = (
      <Box>
        <Box width={listWidth} height={bodyHeight} flexDirection="column" overflow="hidden">
          {filter ? (
            <Text dimColor>
              filter: <Text color="cyan">{filter}</Text> · {rows.length} of {projectRows.length} · esc clears
            </Text>
          ) : null}
          <VmList
            rows={ordered}
            selected={selected}
            width={listWidth}
            height={bodyHeight - (filter ? 1 : 0)}
            compact={showInspector || !wide}
            grouped={grouped}
            providerLabels={providerLabels}
            now={now}
          />
        </Box>
        {showInspector ? (
          <Box
            height={bodyHeight}
            overflow="hidden"
            borderStyle="single"
            borderTop={false}
            borderBottom={false}
            borderRight={false}
            borderDimColor
            paddingLeft={1}
          >
            <Inspector
              row={selected}
              providerLabel={providerLabels[selected?.vm?.provider ?? selected?.job?.provider ?? ""] ?? ""}
              now={now}
              snapshots={snapshotsOf(selected)}
              width={INSPECTOR_WIDTH - 1}
            />
          </Box>
        ) : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} height={frameHeight}>
      <Header
        tab={tab}
        counts={{ vms: list === null ? null : projectRows.length, snapshots: tabSnapshots?.length ?? null, projects: knownProjects.length }}
        right={headerRight}
        narrow={!wide}
      />
      <Rule width={inner} />
      <Box flexDirection="column" height={bodyHeight} flexShrink={0} overflow="hidden">
        {content}
      </Box>
      <Rule width={inner} />
      {/* Progress and messages share two fixed lines; a long message wraps into the second. */}
      <Box flexDirection="column" height={2} flexShrink={0} overflow="hidden">
        <ProgressLine items={progress} />
        <MessageLine message={message} />
      </Box>
      <Box height={1} flexShrink={0} overflow="hidden">
      {filtering ? (
        <Box gap={1}>
          <Text color="cyan">/</Text>
          <TextInput
            defaultValue={filter}
            placeholder="type part of a VM name"
            onChange={(value) => {
              setFilter(value);
              setSelectedName(null);
            }}
            onSubmit={() => setFiltering(false)}
          />
          <Text dimColor>⏎ keep · esc clear</Text>
        </Box>
      ) : overlay ? null : (
        <KeyBar local={bar.local} global={bar.global} />
      )}
      </Box>
    </Box>
  );
}

function DeleteConfirm({ row, snapshots, error }: { row: Row; snapshots: FleetSnapshot[] | null; error?: string }) {
  const vmMonthly = row.vm ? (hourlyRate(row.vm) ?? 0) * HOURS_PER_MONTH : 0;
  const saves = vmMonthly + (snapshots ?? []).reduce((sum, s) => sum + (s.monthly ?? 0), 0);
  const items = 1 + (snapshots?.length ?? 0);
  return (
    <Modal title={`Delete ${row.name}?`} tone="red" width={76}>
      <Text>Destroys the VM and everything on it.{snapshots && snapshots.length > 0 ? " These go too:" : ""}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color="red">  ✕ </Text>
          {row.name.padEnd(34)}
          {"VM".padEnd(14)}
          <Text dimColor>{row.vm && hourlyRate(row.vm) !== null ? `${formatRate(hourlyRate(row.vm)!)}/hr` : ""}</Text>
        </Text>
        {snapshots === null ? (
          <Spinner label="Checking for its snapshots…" />
        ) : (
          snapshots.map((s) => (
            <Text key={s.id}>
              <Text color="red">  ✕ </Text>
              {s.name.slice(0, 33).padEnd(34)}
              {`${s.sizeGb} GB snap`.padEnd(14)}
              <Text dimColor>{s.monthly === null ? "" : `${formatCost(s.monthly)}/mo`}</Text>
            </Text>
          ))
        )}
      </Box>
      {error ? <Text color="yellow">Couldn't check its snapshots ({error}); only the VM will be deleted.</Text> : null}
      <Box marginTop={1}>
        <Text dimColor>
          {saves > 0 ? `Saves about ${formatCost(saves)}/mo. ` : ""}Can't be undone.
        </Text>
      </Box>
      <Box marginTop={1}>
        {snapshots === null ? (
          <KeyBar local={[["esc", "cancel"]]} global={[]} />
        ) : (
          <KeyBar
            local={[
              ["y", items === 1 ? "delete" : `delete all ${items}`],
              ...(snapshots.length > 0 ? ([["k", "keep snapshots"]] as KeyHint[]) : []),
              ["esc", "cancel"],
            ]}
            global={[]}
          />
        )}
      </Box>
    </Modal>
  );
}

function SleepConfirm({ vm, kind }: { vm: FleetVm; kind: "snapshot" | "stop" }) {
  const now = vm.pricing ? `${formatRate(vm.pricing.hourly)}/hr` : "its running price";
  return kind === "snapshot" ? (
    <Box flexDirection="column">
      <Text color="yellow">
        It's shut down, snapshotted and deleted until you wake it: {now} becomes $0.06 per GB of disk in use per
        month.
      </Text>
      <Text color="yellow">
        Sleeping and waking each take a minute or two (longer for big disks); it gets a new IP. Running programs
        stop. The snapshot includes everything on the disk, including signed-in credentials.
      </Text>
    </Box>
  ) : (
    <Text color="yellow">
      It's stopped until you wake it, and you pay only for its disk
      {vm.pricing ? ` (${formatRate(vm.pricing.stoppedHourly)}/hr)` : ""}. It gets a new IP when it wakes. Running
      programs stop.
    </Text>
  );
}


export function SetupNeeded({ error }: { error: string }) {
  const { exit } = useApp();
  useInput(() => exit());

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>
      <Text bold color="cyan">
        convoy
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
