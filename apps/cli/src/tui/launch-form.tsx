import { useEffect, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import { Spinner } from "@inkjs/ui";
import {
  AGENT_TOOLS,
  DESKTOP_MIN_RAM_GB,
  keyStatus,
  missingKey,
  type AgentKeys,
  type Fleet,
  type Region,
  type SignInMode,
  type Size,
  type ToolId,
} from "@convoy/core";
import { placementFor, type LaunchPrefs } from "../prefs";
import { fit, Key, KeyBar, Modal } from "./ui";

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

type Loadable<T> = { state: "loading" } | { state: "error"; error: string } | { state: "ready"; value: T };

type Field = "provider" | "region" | "size" | "signin" | "tools" | "count";
const FIELDS: Field[] = ["provider", "region", "size", "signin", "tools", "count"];
const LABELS: Record<Field, string> = {
  provider: "Cloud",
  region: "Region",
  size: "Size",
  signin: "Sign-in",
  tools: "Tools",
  count: "How many",
};

// Launching many VMs at once is a swarm; keep it under typical account limits.
const MAX_COUNT = 10;

/** Options below the tools that aren't agent tools. */
export interface Extras {
  tailscale: boolean;
  desktop: boolean;
}

export interface LaunchFormProps {
  fleet: Fleet;
  initial: LaunchPrefs;
  keys: AgentKeys;
  /** Project new VMs launch into, or null. */
  project: string | null;
  /** Repos the project clones onto new VMs. */
  repos: string[];
  onLaunch: (choice: LaunchPrefs, count: number) => void;
  onCancel: () => void;
}

/** Every choice on one sheet, filled in from last time. Enter launches; → changes the selected row. */
export function LaunchForm({ fleet, initial, keys, project, repos, onLaunch, onCancel }: LaunchFormProps) {
  const [providerName, setProviderName] = useState(initial.provider);
  const [region, setRegion] = useState(initial.region);
  const [size, setSize] = useState(initial.size);
  const [signIn, setSignIn] = useState(initial.signIn);
  const [tools, setTools] = useState<ToolId[]>(initial.tools);
  const [extras, setExtras] = useState<Extras>({ tailscale: initial.tailscale, desktop: initial.desktop });
  const [count, setCount] = useState(1);
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<Field | null>(null);
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
  const sizeMissing = sizes.state === "ready" && !sizeInfo;
  // Tools missing a required API key can't be launched with.
  const usable = tools.filter((id) => !missingKey(id, keys, signIn));
  const field = FIELDS[cursor]!;

  useInput(
    (input, key) => {
      if (key.escape) return onCancel();
      if (key.upArrow || input === "k") return setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow || input === "j") return setCursor((c) => Math.min(FIELDS.length - 1, c + 1));
      if (field === "count") {
        if (key.rightArrow || input === "+" || input === "=") return setCount((c) => Math.min(MAX_COUNT, c + 1));
        if (key.leftArrow || input === "-") return setCount((c) => Math.max(1, c - 1));
      } else if (key.rightArrow || input === " " || input === "l") {
        return setEditing(field);
      }
      if (key.return) {
        if (sizeMissing) return (setCursor(FIELDS.indexOf("size")), setEditing("size"));
        onLaunch({ provider: providerName, region, size, tools: usable, signIn, ...extras }, count);
      }
    },
    { isActive: editing === null },
  );

  const done = () => setEditing(null);
  const value: Record<Field, ReactNode> = {
    provider: cloud.label,
    region: regionLabel(regions, region),
    size: sizeMissing ? <Text color="yellow">{size} isn't available in {region}; pick another</Text> : sizeLabel(size, sizeInfo),
    signin: SIGN_IN_OPTIONS.find((o) => o.mode === signIn)!.label,
    tools: (
      <Text>
        {AGENT_TOOLS.filter((t) => usable.includes(t.id))
          .map((t) => t.name)
          .join(", ") || <Text dimColor>no agent tools</Text>}
        {extras.desktop || extras.tailscale ? (
          <Text dimColor> + {[extras.desktop && "desktop", extras.tailscale && "Tailscale"].filter(Boolean).join(", ")}</Text>
        ) : null}
      </Text>
    ),
    count: (
      <Text>
        <Text dimColor>‹ </Text>
        <Text bold>{count}</Text>
        <Text dimColor> ›</Text>
      </Text>
    ),
  };


  return (
    <Modal title={`New VM${project ? ` in ${project}` : ""}`} width={92}>
      {FIELDS.map((f, i) => {
        const isCursor = i === cursor && editing === null;
        return (
          <Box key={f}>
            <Box flexShrink={0}>
              <Text color="cyan">{isCursor || editing === f ? "❯ " : "  "}</Text>
              <Text dimColor={!isCursor} bold={isCursor}>
                {LABELS[f].padEnd(10)}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">{value[f]}</Text>
            </Box>
            {isCursor && f !== "count" ? <Text color="cyan"> ▸ change</Text> : null}
          </Box>
        );
      })}
      <Box>
        <Text dimColor>{"  "}{"Repos".padEnd(10)}</Text>
        <Text dimColor wrap="truncate-end">
          {repos.length > 0 ? repos.join("  ") : project ? "none (add some in Projects, tab 3)" : "none (projects can clone repos)"}
        </Text>
      </Box>

      {editing ? (
        <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          {editing === "provider" && (
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
                done();
              }}
              onBack={done}
            />
          )}
          {editing === "region" && (
            <Loading data={regions} label="Loading regions…">
              {(list) => <RegionList list={list} region={region} size={size} onPick={(slug) => (setRegion(slug), done())} onBack={done} />}
            </Loading>
          )}
          {editing === "size" && (
            <Loading data={sizes} label="Loading sizes…">
              {(list) => (
                <SizeList list={list} region={region} size={size} last={initial.size} onPick={(name) => (setSize(name), done())} onBack={done} />
              )}
            </Loading>
          )}
          {editing === "signin" && <SignInStep current={signIn} keys={keys} onPick={(mode) => (setSignIn(mode), done())} onBack={done} />}
          {editing === "tools" && (
            <ToolsPicker
              initial={tools}
              initialExtras={extras}
              keys={keys}
              mode={signIn}
              ramGb={sizeInfo?.ramGb}
              onDone={(chosen, chosenExtras) => {
                setTools(chosen);
                setExtras(chosenExtras);
                done();
              }}
              onBack={done}
            />
          )}
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Box paddingLeft={2} flexDirection="column">
            {sizeInfo?.priceMonthly != null ? (
              <Text>
                <Text bold>
                  ≈ ${sizeInfo.priceMonthly * count}/mo
                </Text>
                <Text dimColor>
                  {" "}
                  while running{count > 1 ? ` for ${count} VMs` : ""}, billed by the hour · sleeping costs only storage
                </Text>
              </Text>
            ) : (
              <Text dimColor>No price from {cloud.label} for this size.</Text>
            )}
            {extras.desktop && sizeInfo && sizeInfo.ramGb < DESKTOP_MIN_RAM_GB ? (
              <Text color="yellow">
                The desktop is cramped in {sizeInfo.ramGb} GB; pick a size with {DESKTOP_MIN_RAM_GB} GB+.
              </Text>
            ) : null}
            {count > 1 && signIn === "subscription" ? (
              <Text color="yellow">
                Each VM needs its own sign-in, and plan limits assume ordinary individual use. For swarms, use API keys.
              </Text>
            ) : null}
          </Box>
          <Box marginTop={1}>
            <KeyBar
              local={[
                ["⏎", count === 1 ? "launch" : `launch ${count}`],
                ["↑↓", "field"],
                field === "count" ? ["←→", "how many"] : ["→", "change"],
                ["esc", "cancel"],
              ]}
              global={[]}
            />
          </Box>
        </Box>
      )}
    </Modal>
  );
}

interface ProviderStepProps {
  fleet: Fleet;
  current: string;
  onPick: (name: string) => void;
  onBack: () => void;
}

// Enabled providers first; the rest are listed with how to turn them on.
function ProviderStep({ fleet, current, onPick, onBack }: ProviderStepProps) {
  const options = [
    ...fleet.clouds.map((c) => ({ name: c.name, label: c.label, hint: `${c.defaults.region} · ${c.defaults.size}`, enabled: true })),
    ...fleet.config.notEnabled.map((c) => ({ name: c.name, label: c.label, hint: c.setupHint, enabled: false })),
  ];
  const { cursor, top, move } = useCursor(options.length, options.findIndex((o) => o.name === current));
  const [note, setNote] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape || key.leftArrow) return onBack();
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
      {note ? <Text color="yellow">{note}</Text> : null}
      <PickerKeys />
    </Box>
  );
}

function PickerKeys({ filter }: { filter?: boolean }) {
  return (
    <Box marginTop={1} gap={2}>
      <Key k="↑↓" label="choose" />
      <Key k="⏎" label="pick" />
      {filter ? <Key k="type" label="to filter" /> : null}
      <Key k="esc" label="back" />
    </Box>
  );
}

function regionLabel(regions: Loadable<Region[]>, slug: string): string {
  const name = regions.state === "ready" ? regions.value.find((r) => r.slug === slug)?.name : undefined;
  return name && name !== slug ? `${slug}  ${name}` : slug;
}

function sizeLabel(name: string, size: Size | undefined): string {
  if (!size) return name;
  return `${name}   ${size.vcpus} vCPU · ${size.ramGb} GB · ${size.diskGb} GB disk${size.priceMonthly != null ? ` · $${size.priceMonthly}/mo` : ""}`;
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
  return { cursor: clamped, top, move, setCursor };
}

/** Typing filters a picker; arrows move. */
function useFilter() {
  const [filter, setFilter] = useState("");
  const handle = (input: string, key: { backspace: boolean; delete: boolean; ctrl: boolean; meta: boolean }) => {
    if (key.backspace || key.delete) return (setFilter((f) => f.slice(0, -1)), true);
    if (!key.ctrl && !key.meta && /^[a-z0-9.\- ]$/i.test(input)) return (setFilter((f) => f + input.toLowerCase()), true);
    return false;
  };
  return { filter, handle };
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

function FilterLine({ filter, shown, total }: { filter: string; shown: number; total: number }) {
  if (!filter) return null;
  return (
    <Text dimColor>
      filter: <Text color="cyan">{filter}▏</Text> · {shown} of {total}
    </Text>
  );
}

interface RegionListProps {
  list: Region[];
  region: string;
  size: string;
  onPick: (slug: string) => void;
  onBack: () => void;
}

function RegionList({ list, region, size, onPick, onBack }: RegionListProps) {
  const { filter, handle } = useFilter();
  const shown = list.filter((r) => `${r.slug} ${r.name}`.toLowerCase().includes(filter));
  const { cursor, top, move, setCursor } = useCursor(shown.length, shown.findIndex((r) => r.slug === region));
  const offering = list.filter((r) => r.sizes?.includes(size)).length;
  const slugWidth = Math.max(0, ...list.map((r) => r.slug.length)) + 2;

  useInput((input, key) => {
    if (key.escape || key.leftArrow) return onBack();
    if (key.upArrow) return move(-1);
    if (key.downArrow) return move(1);
    if (key.return && shown[cursor]) return onPick(shown[cursor].slug);
    if (handle(input, key)) setCursor(0);
  });

  return (
    <Box flexDirection="column">
      <FilterLine filter={filter} shown={shown.length} total={list.length} />
      <ListWindow
        items={shown}
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
        <Text dimColor>
          {offering} of {list.length} regions can create {size} right now.
        </Text>
      ) : null}
      <PickerKeys filter />
    </Box>
  );
}

// Node-based agent CLIs and their installs struggle below this.
const MIN_RAM_GB = 2;
const SIZE_NAME = 20;

interface SizeListProps {
  list: Size[];
  region: string;
  size: string;
  /** Size of the last launch, marked in the list. */
  last: string;
  onPick: (name: string) => void;
  onBack: () => void;
}

function SizeList({ list, region, size, last, onPick, onBack }: SizeListProps) {
  const { filter, handle } = useFilter();
  const shown = list.filter((s) => s.name.toLowerCase().includes(filter));
  const { cursor, top, move, setCursor } = useCursor(shown.length, shown.findIndex((s) => s.name === size));

  useInput((input, key) => {
    if (key.escape || key.leftArrow) return onBack();
    if (key.upArrow) return move(-1);
    if (key.downArrow) return move(1);
    if (key.return && shown[cursor]) return onPick(shown[cursor].name);
    if (handle(input, key)) setCursor(0);
  });

  if (list.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No sizes can be created in {region} right now.</Text>
        <Box marginTop={1}>
          <Key k="esc" label="back" />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <FilterLine filter={filter} shown={shown.length} total={list.length} />
      <Text dimColor>
        {"  "}
        {"SIZE".padEnd(SIZE_NAME + 2)}
        {"vCPU".padEnd(6)}
        {"RAM".padEnd(8)}
        {"DISK".padEnd(9)}
        {"$/MO".padEnd(7)}
      </Text>
      <ListWindow
        items={shown}
        cursor={cursor}
        top={top}
        render={(s, isCursor) => (
          <Text bold={isCursor} dimColor={s.ramGb < MIN_RAM_GB} wrap="truncate-end">
            {fit(s.name, SIZE_NAME)}
            {"  "}
            {String(s.vcpus).padStart(3).padEnd(6)}
            {`${s.ramGb} GB`.padEnd(8)}
            {`${s.diskGb} GB`.padEnd(9)}
            {(s.priceMonthly != null ? `$${s.priceMonthly}` : "").padEnd(7)}
            <Text color={s.ramGb < MIN_RAM_GB ? undefined : "green"} dimColor={s.ramGb < MIN_RAM_GB}>
              {s.ramGb < MIN_RAM_GB ? "too little RAM for agent tools" : s.name === last ? "last used" : ""}
            </Text>
            {s.ramGb >= MIN_RAM_GB && s.name !== last && s.ramGb >= DESKTOP_MIN_RAM_GB * 2 ? (
              <Text dimColor>room for the desktop</Text>
            ) : null}
          </Text>
        )}
      />
      <PickerKeys filter />
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
    if (key.escape || key.leftArrow) return onBack();
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
          .env keys: ANTHROPIC_API_KEY {keys.anthropic ? "✓" : "✗"} · OPENAI_API_KEY {keys.openai ? "✓" : "✗"} ·
          GITHUB_TOKEN {keys.github ? "✓ (either way)" : "✗"}
        </Text>
      </Box>
      <PickerKeys />
    </Box>
  );
}

interface ToolsPickerProps {
  initial: ToolId[];
  initialExtras: Extras;
  keys: AgentKeys;
  mode: SignInMode;
  /** RAM of the chosen size, when known. */
  ramGb: number | undefined;
  onDone: (tools: ToolId[], extras: Extras) => void;
  onBack: () => void;
}

const EXTRAS: { id: keyof Extras; name: string; description: string }[] = [
  { id: "desktop", name: "Desktop", description: "Linux desktop + Firefox, in your browser" },
  { id: "tailscale", name: "Tailscale", description: "Reach it from your phone, no open ports" },
];

function ToolsPicker({ initial, initialExtras, keys, mode, ramGb, onDone, onBack }: ToolsPickerProps) {
  const available = AGENT_TOOLS.filter((tool) => !missingKey(tool.id, keys, mode)).map((tool) => tool.id);
  const [cursor, setCursor] = useState(0);
  const [chosen, setChosen] = useState<Set<ToolId>>(new Set(initial.filter((id) => available.includes(id))));
  const [extras, setExtras] = useState(initialExtras);
  // Extras rows come after the tools.
  const extra = EXTRAS[cursor - AGENT_TOOLS.length];

  useInput((input, key) => {
    if (key.escape || key.leftArrow) return onBack();
    if (key.upArrow || input === "k") return setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow || input === "j") return setCursor((c) => Math.min(AGENT_TOOLS.length + EXTRAS.length - 1, c + 1));
    if (input === " " && extra) return setExtras((current) => ({ ...current, [extra.id]: !current[extra.id] }));
    if (input === " ") {
      const id = AGENT_TOOLS[cursor]!.id;
      if (!available.includes(id)) return;
      return setChosen((current) => {
        const next = new Set(current);
        if (!next.delete(id)) next.add(id);
        return next;
      });
    }
    if (input === "a") return setChosen((current) => new Set(current.size === available.length ? [] : available));
    if (key.return) onDone(AGENT_TOOLS.filter((tool) => chosen.has(tool.id)).map((tool) => tool.id), extras);
  });

  const extraStatus: Record<keyof Extras, { text: string; ok: boolean }> = {
    tailscale: { text: keys.tailscale ? "joins with TAILSCALE_AUTH_KEY" : "sign in on the VM", ok: true },
    desktop:
      ramGb !== undefined && ramGb < DESKTOP_MIN_RAM_GB
        ? { text: `cramped in ${ramGb} GB; pick ${DESKTOP_MIN_RAM_GB} GB+`, ok: false }
        : { text: "adds a few minutes to setup", ok: true },
  };

  const line = (key: string, isCursor: boolean, on: boolean, name: string, description: string, status: { text: string; ok: boolean } | null) => (
    <Box key={key}>
      <Box flexShrink={0}>
        <Text color="cyan">{isCursor ? "❯ " : "  "}</Text>
        <Text color={on ? "green" : undefined} dimColor={!on}>
          {on ? "☑ " : "☐ "}
        </Text>
      </Box>
      <Box width={16} flexShrink={0}>
        <Text bold={isCursor}>{name}</Text>
      </Box>
      <Box width={42} flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          {description}
        </Text>
      </Box>
      {status ? (
        <Box flexShrink={1}>
          <Text color={status.ok ? undefined : "yellow"} dimColor={status.ok} wrap="truncate-end">
            {status.text}
          </Text>
        </Box>
      ) : null}
    </Box>
  );

  return (
    <Box flexDirection="column">
      {AGENT_TOOLS.map((tool, index) => line(tool.id, index === cursor, chosen.has(tool.id), tool.name, tool.description, keyStatus(tool.id, keys, mode)))}
      <Box marginTop={1} flexDirection="column">
        {EXTRAS.map((option, index) =>
          line(option.id, AGENT_TOOLS.length + index === cursor, extras[option.id], option.name, option.description, extraStatus[option.id]),
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Always included: firewall (SSH only), fail2ban, security patches, git, gh, Node.js, Python, tmux.</Text>
      </Box>
      <Box marginTop={1} gap={2}>
        <Key k="space" label="toggle" />
        <Key k="a" label="all/none" />
        <Key k="⏎" label="done" />
        <Key k="esc" label="back" />
      </Box>
    </Box>
  );
}
