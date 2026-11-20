import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { formatCost, formatMinutes, formatRate, hourlyRate, monthToDateCost, type FleetVm } from "@convoy/core";
import { fit, Glyph, type Tone } from "./ui";

export type Phase = "creating" | "booting" | "installing" | "ready" | "failed";

/** A VM launched in this session, tracked through setup. */
export interface Job {
  name: string;
  phase: Phase;
  provider: string;
  region: string;
  project: string | null;
  vmId?: string;
  /** Setup's current phase on the VM, e.g. "adding Claude Code". */
  step?: string;
}

export interface Row {
  key: string;
  name: string;
  id?: string;
  vm?: FleetVm;
  job?: Job;
  deleting: boolean;
  /** Sleep, wake or snapshot step in progress. */
  busy?: string;
  /** Minutes of idleness before auto-sleep, if on. */
  autosleep?: number;
}

export function rowProject(row: Row): string | null {
  return row.vm?.project ?? row.job?.project ?? null;
}

/** Rows ordered by project (no project last), then newest first, as the list shows them. */
export function groupRows(rows: Row[]): { project: string | null; rows: Row[] }[] {
  const groups = new Map<string | null, Row[]>();
  for (const row of rows) {
    const p = rowProject(row);
    groups.set(p, [...(groups.get(p) ?? []), row]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([project, rows]) => ({ project, rows }));
}

const SETTING_UP: Phase[] = ["creating", "booting", "installing"];

/** What the row is doing right now, if anything: shown in its status and the progress line. */
export function rowActivity(row: Row): string | null {
  if (row.deleting) return "deleting";
  if (row.busy) return row.busy;
  if (row.job && SETTING_UP.includes(row.job.phase)) {
    return row.job.phase === "installing" ? (row.job.step ?? "installing tools") : row.job.phase;
  }
  return null;
}

export function rowTone(row: Row): Tone {
  if (rowActivity(row)) return "working";
  if (row.job?.phase === "failed") return "failed";
  switch (row.vm?.status) {
    case "running":
      return "running";
    case "asleep":
      return "asleep";
    case "stopped":
      // DigitalOcean keeps billing stopped VMs in full; only delete stops it.
      return row.vm.pricing && row.vm.pricing.stoppedHourly >= row.vm.pricing.hourly ? "billed" : "stopped";
    case "error":
      return "failed";
    default:
      return "working";
  }
}

export function rowStatus(row: Row): string {
  const activity = rowActivity(row);
  if (activity) return activity;
  if (row.job?.phase === "failed") return "setup failed";
  switch (row.vm?.status) {
    case "running":
      return row.autosleep ? `running  zz ${formatMinutes(row.autosleep)}` : "running";
    case "asleep":
      return "asleep";
    case "stopped":
      return rowTone(row) === "billed" ? "stopped, billed" : "stopped";
    case "provisioning":
      return "starting";
    case "error":
      return "error";
    default:
      return row.vm?.providerStatus ?? "";
  }
}

function age(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

function money(value: number | null | undefined, format: (n: number) => string): string {
  return value === undefined || value === null ? "—" : format(value);
}

/**
 * Which lines of a list to show in `room` lines so line `at` is visible. When lines are cut
 * off, a "more" indicator takes the first or last line of the room. A heading (isRow false)
 * just above the window is pulled in with its first row when the selection still fits.
 */
export function scrollWindow(isRow: boolean[], at: number, room: number): { start: number; end: number } {
  const n = isRow.length;
  if (n <= room) return { start: 0, end: n };
  const windowAt = (top: number) => {
    const start = top + (top > 0 ? 1 : 0);
    const end = Math.min(n, top + room - (n - top - room > 0 ? 1 : 0));
    return { top, start, end, fits: at >= start && at < end };
  };
  let view = windowAt(Math.min(Math.max(0, at - Math.floor(room / 2)), n - room));
  while (!view.fits && at < view.start && view.top > 0) view = windowAt(view.top - 1);
  while (!view.fits && at >= view.end && view.top < n - room) view = windowAt(view.top + 1);
  if (view.top > 0 && isRow[view.start] && !isRow[view.start - 1]) {
    const up = windowAt(view.top - 1);
    if (up.fits) view = up;
  }
  return { start: view.start, end: view.end };
}

export interface VmListProps {
  rows: Row[];
  selected: Row | undefined;
  /** Columns available to the list. */
  width: number;
  /** With the inspector beside it, the list keeps to the essentials. */
  compact: boolean;
  /** Group headings, when more than one project shows. */
  grouped: boolean;
  /** Lines available; a longer list scrolls to keep the selection in view. */
  height: number;
  providerLabels: Record<string, string>;
  now: Date;
}

export function VmList({ rows, selected, width, height, compact, grouped, providerLabels, now }: VmListProps) {
  // Fixed columns; the name takes what's left.
  // Zero-width columns aren't shown.
  const cols = compact
    ? { status: 17, ip: 0, cloud: 0, age: 4, region: 6, rate: 7, cost: 0 }
    : { status: 19, ip: 16, cloud: 13, age: 4, region: 7, rate: 8, cost: 11 };
  const fixed = Object.values(cols).reduce((a, b) => a + b, 0);
  const nameWidth = Math.max(12, Math.min(26, width - 4 - fixed - 1));

  const line = (row: Row) => {
    const isSelected = row === selected;
    const vm = row.vm;
    const activity = rowActivity(row);
    const status = rowStatus(row);
    const statusColor = rowTone(row) === "failed" ? "red" : activity ? "yellow" : rowTone(row) === "asleep" ? "blue" : undefined;
    return (
      <Box key={row.key} flexShrink={0}>
        <Text color="cyan">{isSelected ? "❯ " : "  "}</Text>
        <Glyph tone={rowTone(row)} />
        <Text> </Text>
        <Text bold={isSelected}>{fit(row.name, nameWidth)}</Text>
        <Box width={cols.status}>
          {activity ? (
            <Box>
              <Box flexShrink={0}>
                <Spinner />
              </Box>
              <Text color="yellow">{` ${fit(activity, cols.status - 3)}`}</Text>
            </Box>
          ) : (
            <Text color={statusColor}>{fit(status, cols.status)}</Text>
          )}
        </Box>
        {cols.ip > 0 && <Text dimColor={!vm?.publicIp}>{fit(vm?.publicIp ?? "—", cols.ip)}</Text>}
        {cols.cloud > 0 && <Text>{fit(providerLabels[vm?.provider ?? row.job?.provider ?? ""] ?? "", cols.cloud)}</Text>}
        {compact && <Text dimColor>{(vm ? age(vm.createdAt) : "").padStart(3).padEnd(cols.age)}</Text>}
        <Text dimColor>{fit(vm?.region ?? row.job?.region ?? "", cols.region)}</Text>
        <Text>{fit(vm ? money(hourlyRate(vm), formatRate) : "", cols.rate)}</Text>
        {cols.cost > 0 && <Text>{fit(vm ? money(monthToDateCost(vm, now), formatCost) : "", cols.cost)}</Text>}
        {!compact && <Text dimColor>{vm ? age(vm.createdAt) : ""}</Text>}
      </Box>
    );
  };

  const header = compact ? null : (
    <Text dimColor>
      {"    "}
      {fit("NAME", nameWidth)}
      {fit("STATUS", cols.status)}
      {fit("IP", cols.ip)}
      {fit("CLOUD", cols.cloud)}
      {fit("REGION", cols.region)}
      {fit("$/HR", cols.rate)}
      {fit("THIS MONTH", cols.cost)}
      AGE
    </Text>
  );

  // Every line the list would show, then the window of them that fits.
  const lines: { key: string; node: ReactNode; row?: Row }[] = grouped
    ? groupRows(rows).flatMap((group) => [
        { key: `group:${group.project ?? ""}`, node: <Text dimColor>{`  ${(group.project ?? "no project").toUpperCase()}`}</Text> },
        ...group.rows.map((row) => ({ key: row.key, node: line(row), row })),
      ])
    : rows.map((row) => ({ key: row.key, node: line(row), row }));
  const room = Math.max(3, height - (header ? 1 : 0));
  const at = Math.max(0, lines.findIndex((l) => l.row === selected));
  const view = scrollWindow(lines.map((l) => Boolean(l.row)), at, room);
  const above = view.start;
  const below = Math.max(0, lines.length - view.end);
  const shown = lines.slice(view.start, view.end);

  return (
    <Box flexDirection="column">
      {header}
      {above > 0 ? <Text dimColor>{`  ↑ ${above} more`}</Text> : null}
      {shown.map((l) => (
        <Box key={l.key}>{l.node}</Box>
      ))}
      {below > 0 ? <Text dimColor>{`  ↓ ${below} more`}</Text> : null}
    </Box>
  );
}
