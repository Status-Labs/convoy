import { useEffect, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import { Spinner } from "@inkjs/ui";
import {
  AGENT_TOOLS,
  keyStatus,
  missingKey,
  type AgentKeys,
  type Fleet,
  type Region,
  type SignInMode,
  type Size,
  type ToolId,
} from "@agent-platform/core";
import { placementFor, type LaunchPrefs } from "../prefs";
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

type Step = "provider" | "region" | "size" | "signin" | "tools";

type Loadable<T> = { state: "loading" } | { state: "error"; error: string } | { state: "ready"; value: T };

export interface LaunchFormProps {
  fleet: Fleet;
  initial: LaunchPrefs;
  keys: AgentKeys;
  /** Project new VMs launch into, or null. */
  project: string | null;
  onLaunch: (choice: LaunchPrefs, count: number) => void;
  onCancel: () => void;
}

/** n → provider → region → size → sign-in → tools. Enter on every step launches with the last choices. */
export function LaunchForm({ fleet, initial, keys, project, onLaunch, onCancel }: LaunchFormProps) {
  const [step, setStep] = useState<Step>("provider");
  const [providerName, setProviderName] = useState(initial.provider);
  const [region, setRegion] = useState(initial.region);
  const [size, setSize] = useState(initial.size);
  const [signIn, setSignIn] = useState(initial.signIn);
  const [regions, setRegions] = useState<Loadable<Region[]>>({ state: "loading" });
  const [sizes, setSizes] = useState<Loadable<Size[]>>({ state: "loading" });
  const cloud = fleet.cloud(providerName);
  const provider = cloud.vms.provider;

  useEffect(() => {
    setRegions({ state: "loading" });
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
  const after = (s: Step) => STEPS.indexOf(step) > STEPS.indexOf(s);

  return (
    <Box flexDirection="column">
      <Text bold>
        New agent VM{project ? <Text> in {project}</Text> : <Text dimColor> (no project · p on the list to pick one)</Text>}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <StepLine label="Cloud" active={step === "provider"} value={cloud.label} />
        <StepLine
          label="Region"
          active={step === "region"}
          value={after("provider") ? regionLabel(regions, region) : ""}
        />
        <StepLine label="Size" active={step === "size"} value={after("region") ? sizeLabel(size, sizeInfo) : ""} />
        <StepLine
          label="Sign-in"
          active={step === "signin"}
          value={after("size") ? SIGN_IN_OPTIONS.find((o) => o.mode === signIn)!.label : ""}
        />
        <StepLine label="Tools" active={step === "tools"} value="" />
      </Box>

      <Box marginTop={1} flexDirection="column">
        {step === "provider" && (
          <ProviderStep
            fleet={fleet}
            current={providerName}
            onPick={(name) => {
              if (name !== providerName) {
                // Regions and sizes are per provider; start from that one's last choices.
                const placement = placementFor(fleet, name);
                setProviderName(name);
                setRegion(placement.region);
                setSize(placement.size);
              }
              setStep("region");
            }}
            onBack={onCancel}
          />
        )}
        {step === "region" && (
          <RegionStep
            regions={regions}
            region={region}
            size={size}
            onPick={(slug) => {
              setRegion(slug);
              setStep("size");
            }}
            onBack={() => setStep("provider")}
          />
        )}
        {step === "size" && (
          <SizeStep
            sizes={sizes}
            region={region}
            size={size}
            onPick={(name) => {
              setSize(name);
              setStep("signin");
            }}
            onBack={() => setStep("region")}
          />
        )}
        {step === "signin" && (
          <SignInStep
            current={signIn}
            keys={keys}
            onPick={(mode) => {
              setSignIn(mode);
              setStep("tools");
            }}
            onBack={() => setStep("size")}
          />
        )}
        {step === "tools" && (
          <ToolStep
            initial={initial.tools}
            initialTailscale={initial.tailscale}
            keys={keys}
            mode={signIn}
            summary={`${cloud.label} ${region} · ${sizeLabel(size, sizeInfo)}`}
            onLaunch={(tools, tailscale, count) =>
              onLaunch({ provider: providerName, region, size, tools, signIn, tailscale }, count)
            }
            onBack={() => setStep("signin")}
          />
        )}
      </Box>
    </Box>
  );
}

const STEPS: Step[] = ["provider", "region", "size", "signin", "tools"];

interface ProviderStepProps {
  fleet: Fleet;
  current: string;
  onPick: (name: string) => void;
  onBack: () => void;
}

// Enabled providers first; the rest are listed with how to turn them on.
function ProviderStep({ fleet, current, onPick, onBack }: ProviderStepProps) {
  const options = [
    ...fleet.clouds.map((c) => ({
      name: c.name,
      label: c.label,
      hint: `${c.defaults.region} · ${c.defaults.size}`,
      enabled: true,
    })),
    ...fleet.config.notEnabled.map((c) => ({ name: c.name, label: c.label, hint: c.setupHint, enabled: false })),
  ];
  const { cursor, top, move } = useCursor(
    options.length,
    options.findIndex((o) => o.name === current),
  );
  const [note, setNote] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape) return onBack();
    if (key.upArrow || input === "k") return (setNote(null), move(-1));
    if (key.downArrow || input === "j") return (setNote(null), move(1));
    const option = options[cursor];
    if (key.return && option) {
      if (option.enabled) return onPick(option.name);
      setNote(`${option.label} isn't set up yet: ${option.hint}, then restart.`);
    }
  });

  return (
    <Box flexDirection="column">
      <ListWindow
        items={options}
        cursor={cursor}
        top={top}
        render={(o, isCursor) => (
          <>
            <Box width={16}>
              <Text bold={isCursor} dimColor={!o.enabled}>
                {o.label}
              </Text>
            </Box>
            <Text dimColor>{o.enabled ? o.hint : "not set up"}</Text>
          </>
        )}
      />
      {note ? (
        <Box marginTop={1}>
          <Text color="yellow">{note}</Text>
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
      <Box width={9}>
        <Text bold={active} dimColor={!active}>
          {label}
        </Text>
      </Box>
      <Text dimColor={!active}>{value}</Text>
    </Box>
  );
}

function Loading<T>({
  data,
  label,
  children,
}: {
  data: Loadable<T>;
  label: string;
  children: (value: T) => ReactNode;
}) {
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
      {top > 0 ? <Text dimColor> ↑ {top} more</Text> : null}
      {items.slice(top, top + WINDOW).map((item, i) => (
        <Box key={top + i}>
          <Text color="cyan">{top + i === cursor ? "❯ " : "  "}</Text>
          {render(item, top + i === cursor)}
        </Box>
      ))}
      {top + WINDOW < items.length ? <Text dimColor> ↓ {items.length - top - WINDOW} more</Text> : null}
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
  const { cursor, top, move } = useCursor(
    list.length,
    list.findIndex((r) => r.slug === region),
  );
  const offering = list.filter((r) => r.sizes?.includes(size)).length;
  const slugWidth = Math.max(0, ...list.map((r) => r.slug.length)) + 2;

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
              <Box width={slugWidth}>
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
      {index === -1 ? (
        <Text color="yellow">
          {size} isn't available in {region} right now; pick another size.
        </Text>
      ) : null}
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

const SIGN_IN_OPTIONS: { mode: SignInMode; label: string; detail: string }[] = [
  {
    mode: "subscription",
    label: "Sign in yourself",
    detail: "Use your Claude or ChatGPT plan. Press l on the VM once it's ready.",
  },
  {
    mode: "api-keys",
    label: "API keys from .env",
    detail: "Tools are signed in on boot. Best for swarms of VMs.",
  },
];

interface SignInStepProps {
  current: SignInMode;
  keys: AgentKeys;
  onPick: (mode: SignInMode) => void;
  onBack: () => void;
}

function SignInStep({ current, keys, onPick, onBack }: SignInStepProps) {
  const [cursor, setCursor] = useState(Math.max(0, SIGN_IN_OPTIONS.findIndex((o) => o.mode === current)));

  useInput((input, key) => {
    if (key.escape) return onBack();
    if (key.upArrow || input === "k") return setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow || input === "j") return setCursor((c) => Math.min(SIGN_IN_OPTIONS.length - 1, c + 1));
    if (key.return) onPick(SIGN_IN_OPTIONS[cursor]!.mode);
  });

  return (
    <Box flexDirection="column">
      {SIGN_IN_OPTIONS.map((option, index) => {
        const isCursor = index === cursor;
        return (
          <Box key={option.mode}>
            <Text color="cyan">{isCursor ? "❯ " : "  "}</Text>
            <Box width={20}>
              <Text bold={isCursor}>{option.label}</Text>
            </Box>
            <Text dimColor>{option.detail}</Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>
          .env keys: ANTHROPIC_API_KEY {keys.anthropic ? "✓" : "✗"} · OPENAI_API_KEY {keys.openai ? "✓" : "✗"}
        </Text>
      </Box>
      <Box marginTop={1} gap={2}>
        <Key k="⏎" label="choose" />
        <Key k="esc" label="back" />
      </Box>
    </Box>
  );
}

// Launching many VMs at once is a swarm; keep it under typical account limits.
const MAX_COUNT = 10;

interface ToolStepProps {
  initial: ToolId[];
  initialTailscale: boolean;
  keys: AgentKeys;
  mode: SignInMode;
  summary: string;
  onLaunch: (tools: ToolId[], tailscale: boolean, count: number) => void;
  onBack: () => void;
}

// The Tailscale row sits below the tools, at this cursor position.
const TAILSCALE_ROW = AGENT_TOOLS.length;

function ToolStep({ initial, initialTailscale, keys, mode, summary, onLaunch, onBack }: ToolStepProps) {
  // Tools missing a required API key can't be picked.
  const available = AGENT_TOOLS.filter((tool) => !missingKey(tool.id, keys, mode)).map((tool) => tool.id);
  const [cursor, setCursor] = useState(0);
  const [count, setCount] = useState(1);
  const [chosen, setChosen] = useState<Set<ToolId>>(new Set(initial.filter((id) => available.includes(id))));
  const [tailscale, setTailscale] = useState(initialTailscale);

  useInput((input, key) => {
    if (key.escape) return onBack();
    if (key.upArrow || input === "k") return setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow || input === "j") return setCursor((c) => Math.min(TAILSCALE_ROW, c + 1));
    if (input === " " && cursor === TAILSCALE_ROW) return setTailscale((on) => !on);
    if (input === " ") {
      const id = AGENT_TOOLS[cursor]!.id;
      if (!available.includes(id)) return;
      return setChosen((current) => {
        const next = new Set(current);
        if (!next.delete(id)) next.add(id);
        return next;
      });
    }
    if (input === "a") {
      return setChosen((current) => new Set(current.size === available.length ? [] : available));
    }
    if (input === "+" || input === "=" || key.rightArrow) return setCount((c) => Math.min(MAX_COUNT, c + 1));
    if (input === "-" || key.leftArrow) return setCount((c) => Math.max(1, c - 1));
    if (key.return) {
      onLaunch(AGENT_TOOLS.filter((tool) => chosen.has(tool.id)).map((tool) => tool.id), tailscale, count);
    }
  });

  return (
    <Box flexDirection="column">
      {AGENT_TOOLS.map((tool, index) => {
        const isCursor = index === cursor;
        const isChosen = chosen.has(tool.id);
        const status = keyStatus(tool.id, keys, mode);
        return (
          <Box key={tool.id}>
            <Text color="cyan">{isCursor ? "❯ " : "  "}</Text>
            <Text color={isChosen ? "green" : undefined} dimColor={!isChosen}>
              {isChosen ? "[x] " : "[ ] "}
            </Text>
            <Box width={16}>
              <Text bold={isCursor}>{tool.name}</Text>
            </Box>
            <Box width={44}>
              <Text dimColor>{tool.description}</Text>
            </Box>
            {status && (
              <Text color={status.ok ? undefined : "yellow"} dimColor={status.ok}>
                {status.text}
              </Text>
            )}
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text color="cyan">{cursor === TAILSCALE_ROW ? "❯ " : "  "}</Text>
        <Text color={tailscale ? "green" : undefined} dimColor={!tailscale}>
          {tailscale ? "[x] " : "[ ] "}
        </Text>
        <Box width={16}>
          <Text bold={cursor === TAILSCALE_ROW}>Tailscale</Text>
        </Box>
        <Box width={44}>
          <Text dimColor>Reach it from your phone, no open ports</Text>
        </Box>
        <Text dimColor>{keys.tailscale ? "joins with TAILSCALE_AUTH_KEY" : "sign in on the VM"}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Always included: security updates, firewall (SSH only), fail2ban,</Text>
        <Text dimColor>automatic security patches, git, Node.js, Python, tmux.</Text>
      </Box>

      <Box marginTop={1}>
        <Text>
          Launch <Text bold>{count === 1 ? "1 VM" : `${count} VMs`}</Text> on <Text bold>{summary}</Text>
          {chosen.size === 0 ? " with no tools" : ` with ${chosen.size} tool${chosen.size === 1 ? "" : "s"}`}
          {tailscale ? " on your tailnet" : ""}
        </Text>
      </Box>
      {count > 1 && mode === "subscription" && (
        <Text color="yellow">
          Each VM needs its own sign-in, and plan limits assume ordinary individual use. For swarms, use API keys.
        </Text>
      )}

      <Box marginTop={1} gap={2}>
        <Key k="space" label="toggle" />
        <Key k="a" label="all/none" />
        <Key k="←/→" label="how many VMs" />
        <Key k="⏎" label="launch" />
        <Key k="esc" label="back" />
      </Box>
    </Box>
  );
}
