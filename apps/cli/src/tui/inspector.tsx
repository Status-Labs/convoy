import { useEffect, useState, type ReactNode } from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import {
  formatBytes,
  formatCost,
  formatMinutes,
  formatRate,
  formatUptime,
  hourlyRate,
  monthToDateCost,
  type FleetSnapshot,
  type MetricsSample,
  type VmInfo,
} from "@convoy/core";
import { streamMetrics, vmInfo } from "../ssh";
import { percent, sparkline } from "./detail";
import { fit, Glyph } from "./ui";
import { rowActivity, rowStatus, rowTone, type Row } from "./vm-list";

// Wait for the selection to settle before connecting, so arrowing through the
// list doesn't open an SSH connection per row.
const SETTLE_MS = 400;
const HISTORY = 16;
const INFO_REFRESH_MS = 30_000;

type Loadable<T> = { state: "loading" } | { state: "error"; error: string } | { state: "ready"; value: T };

export interface InspectorProps {
  row: Row | undefined;
  providerLabel: string;
  now: Date;
  /** Snapshots taken from this VM, or null while loading. */
  snapshots: FleetSnapshot[] | null;
  width: number;
}

/** The selected VM, beside the list: what it is, live metrics, what's on it. */
export function Inspector({ row, providerLabel, now, snapshots, width }: InspectorProps) {
  const vm = row?.vm;
  const ip = vm?.status === "running" && !row?.busy ? vm.publicIp : null;
  const [settledIp, setSettledIp] = useState<string | null>(null);
  const [info, setInfo] = useState<Loadable<VmInfo>>({ state: "loading" });
  const [samples, setSamples] = useState<MetricsSample[]>([]);
  // What's on the VM changes as setup runs; read it again when that moves on.
  const activity = row ? rowActivity(row) : null;

  useEffect(() => {
    setInfo({ state: "loading" });
    setSamples([]);
    setSettledIp(null);
    if (!ip) return;
    const timer = setTimeout(() => setSettledIp(ip), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [ip]);

  useEffect(() => {
    if (!settledIp) return;
    let cancelled = false;
    const load = () =>
      vmInfo(settledIp).then(
        (value) => !cancelled && setInfo({ state: "ready", value }),
        (err: Error) => !cancelled && setInfo((c) => (c.state === "ready" ? c : { state: "error", error: err.message })),
      );
    void load();
    const timer = setInterval(load, INFO_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [settledIp, activity]);

  useEffect(() => {
    if (!settledIp) return;
    return streamMetrics(settledIp, (sample) => setSamples((c) => [...c.slice(-(HISTORY - 1)), sample]), () => {});
  }, [settledIp]);

  if (!row) return <Text dimColor>Nothing selected.</Text>;

  const tone = rowTone(row);
  const spec = vm?.spec;
  const rate = vm ? hourlyRate(vm) : null;
  const cost = vm ? monthToDateCost(vm, now) : null;
  const inner = width - 1;

  return (
    <Box flexDirection="column" width={width}>
      <Box justifyContent="space-between">
        <Text bold>{fit(row.name, Math.max(8, inner - 18)).trimEnd()}</Text>
        <Text>
          <Glyph tone={tone} /> {rowStatus(row).split("  ")[0]}
        </Text>
      </Box>
      <Text dimColor wrap="truncate-end">
        {[providerLabel, vm?.region ?? row.job?.region, spec?.size].filter(Boolean).join(" · ")}
      </Text>
      <Text dimColor wrap="truncate-end">
        {vm?.publicIp ?? "no address"}
        {samples.at(-1) ? ` · up ${formatUptime(samples.at(-1)!.uptimeS)}` : ""}
        {rate !== null ? ` · ${formatRate(rate)}/hr` : ""}
        {cost !== null ? ` · ${formatCost(cost)} this month` : ""}
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Body row={row} ip={ip} settled={settledIp !== null} info={info} samples={samples} width={inner} />
      </Box>

      {vm ? (
        <Box marginTop={1} flexDirection="column">
          <Field label="Sleep">
            {vm.status === "asleep" ? (
              <Text>
                asleep · <Text bold>s</Text> wakes it
              </Text>
            ) : row.autosleep ? (
              `after ${formatMinutes(row.autosleep)} idle`
            ) : (
              <Text dimColor>no auto-sleep (a turns it on)</Text>
            )}
          </Field>
          <Field label="Snaps">
            {snapshots === null ? (
              <Text dimColor>…</Text>
            ) : snapshots.length === 0 ? (
              <Text dimColor>{vm.status === "running" ? "none (b takes one)" : "none"}</Text>
            ) : (
              <Text>
                {snapshots.length} · {formatCost(snapshots.reduce((s, x) => s + (x.monthly ?? 0), 0))}/mo{" "}
                <Text dimColor>(2 lists them)</Text>
              </Text>
            )}
          </Field>
        </Box>
      ) : null}
    </Box>
  );
}

function Body({
  row,
  ip,
  settled,
  info,
  samples,
  width,
}: {
  row: Row;
  ip: string | null;
  settled: boolean;
  info: Loadable<VmInfo>;
  samples: MetricsSample[];
  width: number;
}) {
  const activity = rowActivity(row);
  if (!row.vm) {
    return (
      <Box flexDirection="column">
        <Spinner label={activity ?? "starting"} />
        <Text dimColor>Setup runs on the VM; it shows here as it goes.</Text>
      </Box>
    );
  }
  if (row.busy) return <Spinner label={row.busy} />;
  if (row.vm.status === "asleep") {
    return <Text dimColor>Its disk is saved as a snapshot; only storage is billed. Waking takes about 1.5 minutes.</Text>;
  }
  if (!ip) return <Text dimColor>Not running.</Text>;
  if (!settled) return <Text dimColor> </Text>;

  const latest = samples.at(-1);
  const bar = Math.max(8, Math.min(HISTORY, width - 22));
  return (
    <Box flexDirection="column">
      {row.job && activity ? <Spinner label={`setup: ${activity}`} /> : null}
      {latest ? (
        <>
          <Meter label="CPU" spark={sparkline(samples.map((s) => s.cpu)).padStart(bar, " ")} value={latest.cpu} />
          <Meter
            label="MEM"
            spark={sparkline(samples.map((s) => percent(s.memUsed, s.memTotal))).padStart(bar, " ")}
            value={percent(latest.memUsed, latest.memTotal)}
            detail={`${formatBytes(latest.memUsed)}/${formatBytes(latest.memTotal)}`}
          />
          <Meter
            label="DISK"
            spark={barOf(percent(latest.diskUsed, latest.diskTotal), bar)}
            value={percent(latest.diskUsed, latest.diskTotal)}
            detail={`${formatBytes(latest.diskUsed)}/${formatBytes(latest.diskTotal)}`}
          />
        </>
      ) : (
        <Spinner label="Connecting for live metrics…" />
      )}
      <Box marginTop={1} flexDirection="column">
        <InfoFields info={info} />
      </Box>
    </Box>
  );
}

function barOf(pct: number, width: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function Meter({ label, spark, value, detail }: { label: string; spark: string; value: number; detail?: string }) {
  return (
    <Box>
      <Box width={6}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text color="cyan">{spark}</Text>
      <Text color={value > 90 ? "red" : undefined}>{`${Math.round(value)}%`.padStart(5)}</Text>
      {detail ? <Text dimColor wrap="truncate-end">{` ${detail}`}</Text> : null}
    </Box>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box>
      <Box width={8} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexShrink={1}>
        <Text wrap="truncate-end">{children}</Text>
      </Box>
    </Box>
  );
}

function InfoFields({ info }: { info: Loadable<VmInfo> }) {
  if (info.state === "loading") return <Spinner label="Reading what's on it…" />;
  if (info.state === "error") return <Text color="red">Couldn't read the VM: {info.error}</Text>;
  const { tools, desktop, tailscale, github, repos, setup } = info.value;
  return (
    <>
      {setup !== "ready" ? (
        <Field label="Setup">
          <Text color={setup.startsWith("failed") ? "red" : "yellow"}>{setup}</Text>
        </Field>
      ) : null}
      <Field label="Tools">{tools.length > 0 ? tools.map((t) => t.name).join("  ") : <Text dimColor>none</Text>}</Field>
      <Field label="GitHub">
        {github ? github : <Text dimColor>{github === null ? "no gh" : "not signed in (l)"}</Text>}
      </Field>
      <Field label="Repos">{repos.length > 0 ? repos.map((r) => `~/${r}`).join("  ") : <Text dimColor>none</Text>}</Field>
      <Field label="Extras">
        {[desktop ? "desktop" : null, tailscale ? (tailscale.state === "Running" ? "Tailscale" : tailscale.state === "NeedsLogin" ? "Tailscale (needs sign-in: l)" : `Tailscale ${tailscale.state.toLowerCase()}`) : null]
          .filter(Boolean)
          .join(" · ") || <Text dimColor>none</Text>}
      </Field>
    </>
  );
}
