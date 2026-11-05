import { useEffect, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import { Spinner } from "@inkjs/ui";
import {
  formatBytes,
  formatCost,
  formatRate,
  formatUptime,
  hourlyRate,
  monthToDateCost,
  type FleetVm,
  type MetricsSample,
  type VmInfo,
} from "@agent-platform/core";
import { streamMetrics, vmInfo } from "../ssh";
import { Key } from "./key";

// About a minute and a half of history at one sample every 2s.
const HISTORY = 48;
const SPARK = "▁▂▃▄▅▆▇█";
// Tool versions and setup state change rarely; metrics stream separately.
const INFO_REFRESH_MS = 30_000;

export interface DetailProps {
  vm: FleetVm;
  providerLabel: string;
  now: Date;
  onBack: () => void;
  onConnect: () => void;
  onTmux: () => void;
  onSignIn: () => void;
  onDesktop: () => void;
}

type Loadable<T> = { state: "loading" } | { state: "error"; error: string } | { state: "ready"; value: T };

function sparkline(values: number[], max = 100): string {
  return values.map((v) => SPARK[Math.min(SPARK.length - 1, Math.max(0, Math.round((v / max) * (SPARK.length - 1))))]).join("");
}

function percent(used: number, total: number): number {
  return total > 0 ? (used / total) * 100 : 0;
}

/** Full-screen view of one VM: what it is, what it costs, what's on it, and live metrics. */
export function Detail({ vm, providerLabel, now, onBack, onConnect, onTmux, onSignIn, onDesktop }: DetailProps) {
  const ip = vm.status === "running" ? vm.publicIp : null;
  const [info, setInfo] = useState<Loadable<VmInfo>>({ state: "loading" });
  const [samples, setSamples] = useState<MetricsSample[]>([]);
  const [stream, setStream] = useState<"connecting" | "live" | "reconnecting">("connecting");

  useEffect(() => {
    if (!ip) return;
    let cancelled = false;
    const load = () =>
      vmInfo(ip).then(
        (value) => !cancelled && setInfo({ state: "ready", value }),
        (err: Error) => !cancelled && setInfo((current) => (current.state === "ready" ? current : { state: "error", error: err.message })),
      );
    void load();
    const timer = setInterval(load, INFO_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ip]);

  useEffect(() => {
    if (!ip) return;
    // Streaming only while this view is open.
    return streamMetrics(
      ip,
      (sample) => setSamples((current) => [...current.slice(-(HISTORY - 1)), sample]),
      setStream,
    );
  }, [ip]);

  useInput((input, key) => {
    if (key.escape || key.leftArrow || input === "h") return onBack();
    if (!ip) return;
    if (key.return) return onConnect();
    if (input === "t") return onTmux();
    if (input === "l") return onSignIn();
    if (input === "g") return onDesktop();
  });

  const rate = hourlyRate(vm);
  const cost = monthToDateCost(vm, now);
  const spec = vm.spec;
  const latest = samples.at(-1);

  return (
    <Box flexDirection="column">
      <Box gap={2}>
        <Text bold>← {vm.name}</Text>
        <Text color={vm.status === "running" ? "green" : vm.status === "asleep" ? "blue" : "yellow"}>● {vm.status}</Text>
        {info.state === "ready" && <SetupBadge setup={info.value.setup} />}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Field label="Size">
          {spec
            ? [spec.size, spec.vcpus && `${spec.vcpus} vCPU`, spec.ramGb && `${spec.ramGb} GB RAM`, spec.diskGb && `${spec.diskGb} GB disk`]
                .filter(Boolean)
                .join(" · ")
            : "—"}
          {rate !== null && (
            <Text dimColor>
              {"   "}
              {formatRate(rate)}/hr · {cost === null ? "" : `${formatCost(cost)} this month (est.)`}
            </Text>
          )}
        </Field>
        <Field label="Where">
          {providerLabel} · {vm.region}
          {vm.project ? ` · project ${vm.project}` : ""}
          {spec?.image ? ` · ${spec.image}` : ""}
        </Field>
        <Field label="Address">{ip ? `${ip} · pnpm cli ssh ${vm.name}` : "—"}</Field>
        <Field label="Created">
          {new Date(vm.createdAt).toLocaleString()}
        </Field>
      </Box>

      {!ip ? (
        <Box marginTop={1}>
          <Text dimColor>{vm.status === "asleep" ? "Asleep: wake it (w on the list) to see what's on it." : "Not running."}</Text>
        </Box>
      ) : (
        <>
          <Box marginTop={1} flexDirection="column">
            <InfoSection info={info} />
          </Box>
          <Box marginTop={1} flexDirection="column">
            <MetricsSection samples={samples} latest={latest} stream={stream} />
          </Box>
        </>
      )}

      <Box marginTop={1} gap={2}>
        <Key k="⏎" label="connect" />
        <Key k="t" label="tmux" />
        <Key k="l" label="sign in" />
        <Key k="g" label="desktop" />
        <Key k="esc" label="back" />
      </Box>
    </Box>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box>
      <Box width={10} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text>{children}</Text>
    </Box>
  );
}

function SetupBadge({ setup }: { setup: string }) {
  if (setup === "ready") return <Text color="green">✓ setup ready</Text>;
  if (setup.startsWith("failed")) return <Text color="red">✗ setup {setup}</Text>;
  return <Spinner label={`setup: ${setup}`} />;
}

function InfoSection({ info }: { info: Loadable<VmInfo> }) {
  if (info.state === "loading") return <Spinner label="Reading what's on the VM…" />;
  if (info.state === "error") return <Text color="red">Couldn't read the VM: {info.error}</Text>;
  const { tools, desktop, tailscale, github, identity, repos, tmux } = info.value;
  return (
    <>
      <Field label="Tools">
        {tools.length === 0 ? "—" : tools.map((t) => `${t.name} ${t.version}`).join("  ·  ")}
      </Field>
      <Field label="GitHub">
        {github === null ? (
          <Text dimColor>gh not installed</Text>
        ) : github ? (
          `signed in as ${github}`
        ) : (
          <Text dimColor>not signed in (GITHUB_TOKEN in .env, or l to sign in)</Text>
        )}
      </Field>
      <Field label="Commits">{identity ? `by ${identity}` : <Text dimColor>no git identity (set user.name/email locally, then pnpm cli keys)</Text>}</Field>
      <Field label="Repos">{repos.length > 0 ? repos.map((r) => `~/${r}`).join("  ") : <Text dimColor>none cloned</Text>}</Field>
      <Field label="Extras">
        {[
          desktop ? `desktop ${desktop === "active" ? "running" : desktop}` : null,
          tailscale ? `tailnet ${tailscale.state === "Running" ? tailscale.dnsName : tailscale.state.toLowerCase()}` : null,
        ]
          .filter(Boolean)
          .join("  ·  ") || <Text dimColor>no desktop, no Tailscale</Text>}
      </Field>
      {tmux.length > 0 && <Field label="tmux">{tmux.join("  ·  ")}</Field>}
    </>
  );
}

function MetricsSection({
  samples,
  latest,
  stream,
}: {
  samples: MetricsSample[];
  latest: MetricsSample | undefined;
  stream: "connecting" | "live" | "reconnecting";
}) {
  if (!latest) return <Spinner label={stream === "reconnecting" ? "Metrics: reconnecting…" : "Connecting for live metrics…"} />;
  const mem = percent(latest.memUsed, latest.memTotal);
  const disk = percent(latest.diskUsed, latest.diskTotal);
  return (
    <>
      <Box>
        <Box width={6}>
          <Text bold>CPU</Text>
        </Box>
        <Box width={6}>
          <Text>{`${Math.round(latest.cpu)}%`}</Text>
        </Box>
        <Box width={HISTORY + 2}>
          <Text color="cyan">{sparkline(samples.map((s) => s.cpu))}</Text>
        </Box>
        <Text dimColor>
          load {latest.load.map((n) => n.toFixed(2)).join(" ")} · {latest.cores} cores · up {formatUptime(latest.uptimeS)}
        </Text>
      </Box>
      <Box>
        <Box width={6}>
          <Text bold>MEM</Text>
        </Box>
        <Box width={6}>
          <Text>{`${Math.round(mem)}%`}</Text>
        </Box>
        <Box width={HISTORY + 2}>
          <Text color="magenta">{sparkline(samples.map((s) => percent(s.memUsed, s.memTotal)))}</Text>
        </Box>
        <Text dimColor>
          {formatBytes(latest.memUsed)} / {formatBytes(latest.memTotal)}
          {latest.swapTotal > 0 ? ` · swap ${formatBytes(latest.swapUsed)}` : ""}
        </Text>
      </Box>
      <Box>
        <Box width={6}>
          <Text bold>DISK</Text>
        </Box>
        <Box width={6}>
          <Text color={disk > 90 ? "red" : undefined}>{`${Math.round(disk)}%`}</Text>
        </Box>
        <Text dimColor>
          {formatBytes(latest.diskUsed)} / {formatBytes(latest.diskTotal)} · read {formatBytes(latest.diskRead)}/s · write{" "}
          {formatBytes(latest.diskWrite)}/s
        </Text>
      </Box>
      <Box>
        <Box width={12}>
          <Text bold>NET</Text>
        </Box>
        <Text dimColor>
          ↓ {formatBytes(latest.netRx)}/s · ↑ {formatBytes(latest.netTx)}/s
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          {"PROCESS".padEnd(28)}
          {"CPU".padStart(7)}
          {"MEM".padStart(10)}
          {stream === "reconnecting" ? "   (reconnecting…)" : ""}
        </Text>
        {latest.processes.slice(0, 6).map((p) => (
          <Text key={p.pid}>
            {p.command.slice(0, 27).padEnd(28)}
            {`${p.cpu.toFixed(1)}%`.padStart(7)}
            {formatBytes(p.memBytes).padStart(10)}
          </Text>
        ))}
      </Box>
    </>
  );
}
