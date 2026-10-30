import { useEffect, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import { Spinner } from "@inkjs/ui";
import { AGENT_TOOLS, ALL_TOOL_IDS, type Region, type Size, type ToolId, type VmProvider } from "@agent-platform/core";
import type { LaunchPrefs } from "../prefs";
import { Key } from "./key";

// Region and size lists change slowly; cache them so reopening the form is
// instant and doesn't spend API requests.
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value as Promise<T>;
}

type Step = "region" | "size" | "tools";

type Loadable<T> = { state: "loading" } | { state: "error"; error: string } | { state: "ready"; value: T };

export interface LaunchFormProps {
  provider: VmProvider;
  initial: LaunchPrefs;
  onLaunch: (choice: LaunchPrefs) => void;
  onCancel: () => void;
}

/** n → region → size → tools. Enter on every step launches with the last choices. */
export function LaunchForm({ provider, initial, onLaunch, onCancel }: LaunchFormProps) {
  const [step, setStep] = useState<Step>("region");
  const [region, setRegion] = useState(initial.region);
  const [size, setSize] = useState(initial.size);
  const [regions, setRegions] = useState<Loadable<Region[]>>({ state: "loading" });
  const [sizes, setSizes] = useState<Loadable<Size[]>>({ state: "loading" });

  useEffect(() => {
    cached(`${provider.name}:regions`, () => provider.listRegions()).then(
      (value) => setRegions({ state: "ready", value: [...value].sort((a, b) => a.slug.localeCompare(b.slug)) }),
      (err: Error) => setRegions({ state: "error", error: err.message }),
    );
  }, [provider]);

  useEffect(() => {
    setSizes({ state: "loading" });
    cached(`${provider.name}:sizes:${region}`, () => provider.listSizes(region)).then(
      (value) =>
        setSizes({
          state: "ready",
          value: [...value].sort((a, b) => (a.priceMonthly ?? 0) - (b.priceMonthly ?? 0) || a.vcpus - b.vcpus),
        }),
      (err: Error) => setSizes({ state: "error", error: err.message }),
    );
  }, [provider, region]);

  const sizeInfo = sizes.state === "ready" ? sizes.value.find((s) => s.name === size) : undefined;

  return (
    <Box flexDirection="column">
      <Text bold>New agent VM</Text>
      <Box marginTop={1} flexDirection="column">
        <StepLine label="Region" active={step === "region"} value={regionLabel(regions, region)} />
        <StepLine label="Size" active={step === "size"} value={step === "region" ? "" : sizeLabel(size, sizeInfo)} />
        <StepLine label="Tools" active={step === "tools"} value="" />
      </Box>

      <Box marginTop={1} flexDirection="column">
        {step === "region" && (
          <RegionStep
            regions={regions}
            region={region}
            size={size}
            onPick={(slug) => {
              setRegion(slug);
              setStep("size");
            }}
            onBack={onCancel}
          />
        )}
        {step === "size" && (
          <SizeStep
            sizes={sizes}
            region={region}
            size={size}
            onPick={(name) => {
              setSize(name);
              setStep("tools");
            }}
            onBack={() => setStep("region")}
          />
        )}
        {step === "tools" && (
          <ToolStep
            initial={initial.tools}
            summary={`${region} · ${sizeLabel(size, sizeInfo)}`}
            onLaunch={(tools) => onLaunch({ region, size, tools })}
            onBack={() => setStep("size")}
          />
        )}
      </Box>
    </Box>
  );
}

function regionLabel(regions: Loadable<Region[]>, slug: string): string {
  const name = regions.state === "ready" ? regions.value.find((r) => r.slug === slug)?.name : undefined;
  return name && name !== slug ? `${slug}  ${name}` : slug;
}

function sizeLabel(name: string, size: Size | undefined): string {
  if (!size) return name;
  return `${name}  ${size.vcpus} vCPU · ${size.ramGb} GB${size.priceMonthly != null ? ` · $${size.priceMonthly}/mo` : ""}`;
}

function StepLine({ label, active, value }: { label: string; active: boolean; value: string }) {
  return (
    <Box>
      <Text color="cyan">{active ? "❯ " : "  "}</Text>
      <Box width={8}>
        <Text bold={active} dimColor={!active}>
          {label}
        </Text>
      </Box>
      <Text dimColor={!active}>{value}</Text>
    </Box>
  );
}

function Loading<T>({ data, label, children }: { data: Loadable<T>; label: string; children: (value: T) => ReactNode }) {
  if (data.state === "loading") return <Spinner label={label} />;
  if (data.state === "error") return <Text color="red">✗ {data.error}</Text>;
  return <>{children(data.value)}</>;
}

const WINDOW = 10;

/** A vertical list with a cursor that scrolls when longer than the window. */
function useCursor(length: number, start: number) {
  const [cursor, setCursor] = useState(Math.max(0, start));
  const clamped = Math.min(cursor, Math.max(0, length - 1));
  const top = Math.min(Math.max(0, clamped - Math.floor(WINDOW / 2)), Math.max(0, length - WINDOW));
  const move = (delta: number) => setCursor(Math.min(Math.max(0, clamped + delta), Math.max(0, length - 1)));
  return { cursor: clamped, top, move };
}

function ListWindow<T>({
  items,
  cursor,
  top,
  render,
}: {
  items: T[];
  cursor: number;
  top: number;
  render: (item: T, isCursor: boolean) => ReactNode;
}) {
  return (
    <Box flexDirection="column">
      {top > 0 ? <Text dimColor>  ↑ {top} more</Text> : null}
      {items.slice(top, top + WINDOW).map((item, i) => (
        <Box key={top + i}>
          <Text color="cyan">{top + i === cursor ? "❯ " : "  "}</Text>
          {render(item, top + i === cursor)}
        </Box>
      ))}
      {top + WINDOW < items.length ? <Text dimColor>  ↓ {items.length - top - WINDOW} more</Text> : null}
    </Box>
  );
}

interface RegionStepProps {
  regions: Loadable<Region[]>;
  region: string;
  size: string;
  onPick: (slug: string) => void;
  onBack: () => void;
}

function RegionStep({ regions, ...props }: RegionStepProps) {
  return (
    <Loading data={regions} label="Loading regions…">
      {(list) => <RegionList list={list} {...props} />}
    </Loading>
  );
}

function RegionList({ list, region, size, onPick, onBack }: Omit<RegionStepProps, "regions"> & { list: Region[] }) {
  const { cursor, top, move } = useCursor(list.length, list.findIndex((r) => r.slug === region));
  const offering = list.filter((r) => r.sizes?.includes(size)).length;

  useInput((input, key) => {
    if (key.escape) return onBack();
    if (key.upArrow || input === "k") return move(-1);
    if (key.downArrow || input === "j") return move(1);
    if (key.return && list[cursor]) onPick(list[cursor].slug);
  });

  return (
    <Box flexDirection="column">
      <ListWindow
        items={list}
        cursor={cursor}
        top={top}
        render={(r, isCursor) => {
          // Regions that can't create the current size right now are dimmed;
          // they may still offer other sizes.
          const lacksSize = r.sizes !== undefined && !r.sizes.includes(size);
          return (
            <>
              <Box width={8}>
                <Text bold={isCursor} dimColor={lacksSize}>
                  {r.slug}
                </Text>
              </Box>
              <Box width={22}>
                <Text dimColor={lacksSize}>{r.name !== r.slug ? r.name : ""}</Text>
              </Box>
              {lacksSize ? <Text dimColor>no {size} right now</Text> : null}
            </>
          );
        }}
      />
      {list.some((r) => r.sizes) ? (
        <Box marginTop={1}>
          <Text dimColor>
            {offering} of {list.length} regions can create {size} right now.
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1} gap={2}>
        <Key k="↑↓" label="choose" />
        <Key k="⏎" label="next" />
        <Key k="esc" label="cancel" />
      </Box>
    </Box>
  );
}

// Node-based agent CLIs and their installs struggle below this.
const MIN_RAM_GB = 2;

interface SizeStepProps {
  sizes: Loadable<Size[]>;
  region: string;
  size: string;
  onPick: (name: string) => void;
  onBack: () => void;
}

function SizeStep({ sizes, ...props }: SizeStepProps) {
  return (
    <Loading data={sizes} label="Loading sizes…">
      {(list) => <SizeList list={list} {...props} />}
    </Loading>
  );
}

function SizeList({ list, region, size, onPick, onBack }: Omit<SizeStepProps, "sizes"> & { list: Size[] }) {
  const index = list.findIndex((s) => s.name === size);
  const { cursor, top, move } = useCursor(list.length, index);

  useInput((input, key) => {
    if (key.escape) return onBack();
    if (key.upArrow || input === "k") return move(-1);
    if (key.downArrow || input === "j") return move(1);
    if (key.return && list[cursor]) onPick(list[cursor].name);
  });

  if (list.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No sizes can be created in {region} right now.</Text>
        <Box marginTop={1}>
          <Key k="esc" label="pick another region" />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {index === -1 ? <Text color="yellow">{size} isn't available in {region} right now; pick another size.</Text> : null}
      <Text dimColor>
        {"  "}
        {"SIZE".padEnd(22)}
        {"vCPU".padEnd(6)}
        {"RAM".padEnd(8)}
        {"DISK".padEnd(9)}
        PRICE
      </Text>
      <ListWindow
        items={list}
        cursor={cursor}
        top={top}
        render={(s, isCursor) => (
          <Text bold={isCursor} dimColor={s.ramGb < MIN_RAM_GB}>
            {s.name.padEnd(22)}
            {String(s.vcpus).padEnd(6)}
            {`${s.ramGb} GB`.padEnd(8)}
            {`${s.diskGb} GB`.padEnd(9)}
            {(s.priceMonthly != null ? `$${s.priceMonthly}/mo` : "").padEnd(10)}
            {s.ramGb < MIN_RAM_GB ? "too little RAM for agent tools" : ""}
          </Text>
        )}
      />
      <Box marginTop={1} gap={2}>
        <Key k="↑↓" label="choose" />
        <Key k="⏎" label="next" />
        <Key k="esc" label="back" />
      </Box>
    </Box>
  );
}

interface ToolStepProps {
  initial: ToolId[];
  summary: string;
  onLaunch: (tools: ToolId[]) => void;
  onBack: () => void;
}

function ToolStep({ initial, summary, onLaunch, onBack }: ToolStepProps) {
  const [cursor, setCursor] = useState(0);
  const [chosen, setChosen] = useState<Set<ToolId>>(new Set(initial));

  useInput((input, key) => {
    if (key.escape) return onBack();
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

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Always included: security updates, firewall (SSH only), fail2ban,</Text>
        <Text dimColor>automatic security patches, git, Node.js, Python, tmux.</Text>
      </Box>

      <Box marginTop={1}>
        <Text>
          Launch <Text bold>{summary}</Text>
          {chosen.size === 0 ? " with no tools" : ` with ${chosen.size} tool${chosen.size === 1 ? "" : "s"}`}
        </Text>
      </Box>

      <Box marginTop={1} gap={2}>
        <Key k="space" label="toggle" />
        <Key k="a" label="all/none" />
        <Key k="⏎" label="launch" />
        <Key k="esc" label="back" />
      </Box>
    </Box>
  );
}
