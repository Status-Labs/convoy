import type { ReactNode } from "react";
import { Box, Text, useWindowSize } from "ink";
import { Spinner } from "@inkjs/ui";

/** Below this many columns the inspector folds away and `i` opens it full screen. */
export const WIDE_COLUMNS = 100;

export type Tab = "vms" | "snapshots" | "projects";
export const TABS: { id: Tab; key: string; label: string }[] = [
  { id: "vms", key: "1", label: "VMs" },
  { id: "snapshots", key: "2", label: "Snapshots" },
  { id: "projects", key: "3", label: "Projects" },
];

/** One glyph and color per state, used in the list, inspector and progress line. */
export type Tone = "running" | "working" | "asleep" | "stopped" | "billed" | "failed";
export const GLYPHS: Record<Tone, { glyph: string; color?: string; dim?: boolean }> = {
  running: { glyph: "●", color: "green" },
  working: { glyph: "◐", color: "yellow" },
  asleep: { glyph: "☾", color: "blue" },
  stopped: { glyph: "○", dim: true },
  billed: { glyph: "○", color: "yellow" },
  failed: { glyph: "✕", color: "red" },
};

export function Glyph({ tone }: { tone: Tone }) {
  const g = GLYPHS[tone];
  return (
    <Text color={g.color} dimColor={g.dim}>
      {g.glyph}
    </Text>
  );
}

/** Cuts text to a width with an ellipsis, so columns never shift. */
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(0, width - 1))}…`;
}

export function Rule({ width }: { width: number }) {
  return <Text dimColor>{"─".repeat(Math.max(0, width))}</Text>;
}

export function Key({ k, label }: { k: string; label: string }) {
  return (
    <Text>
      <Text bold color="cyan">
        {k}
      </Text>
      <Text dimColor> {label}</Text>
    </Text>
  );
}

export type KeyHint = [key: string, label: string];

/** Keys for what's selected, then app-wide keys after a dot. */
export function KeyBar({ local, global }: { local: KeyHint[]; global: KeyHint[] }) {
  return (
    <Box columnGap={2} flexWrap="wrap">
      {local.map(([k, label]) => (
        <Key key={k} k={k} label={label} />
      ))}
      {local.length > 0 && global.length > 0 ? <Text dimColor>·</Text> : null}
      {global.map(([k, label]) => (
        <Key key={k} k={k} label={label} />
      ))}
    </Box>
  );
}

export function Header({
  tab,
  counts,
  right,
  narrow,
}: {
  tab: Tab;
  counts: Record<Tab, number | null>;
  right: ReactNode;
  narrow: boolean;
}) {
  return (
    <Box justifyContent="space-between">
      <Box columnGap={2}>
        <Text bold color="cyan">
          ◆ convoy
        </Text>
        {TABS.map((t) => {
          const label = `${narrow ? "" : `${t.key} `}${narrow && t.id === "snapshots" ? "Snaps" : t.label}${counts[t.id] === null ? "" : ` ${counts[t.id]}`}`;
          return t.id === tab ? (
            <Text key={t.id} backgroundColor="cyan" color="black" bold>
              {` ${label} `}
            </Text>
          ) : (
            <Text key={t.id} dimColor>
              {label}
            </Text>
          );
        })}
      </Box>
      <Box>{right}</Box>
    </Box>
  );
}

/** Long jobs in progress, shown above the keys wherever you are. */
export function ProgressLine({ items }: { items: { name: string; step: string }[] }) {
  if (items.length === 0) return null;
  const [first, ...rest] = items;
  return (
    <Box columnGap={2}>
      <Spinner />
      <Text color="yellow">{first!.name}</Text>
      <Text wrap="truncate-end">{first!.step}</Text>
      {rest.length > 0 ? <Text dimColor>+{rest.length} more</Text> : null}
    </Box>
  );
}

export type Message = { text: string; tone: "info" | "success" | "error" } | null;

export function MessageLine({ message }: { message: Message }) {
  if (!message) return null;
  return (
    <Text color={message.tone === "error" ? "red" : message.tone === "success" ? "green" : undefined}>
      {message.tone === "error" ? "✗ " : message.tone === "success" ? "✓ " : ""}
      {message.text}
    </Text>
  );
}

/** A bordered panel for questions and forms, drawn in place of the list. */
export function Modal({
  title,
  tone = "cyan",
  width,
  children,
}: {
  title: string;
  tone?: string;
  width?: number;
  children: ReactNode;
}) {
  // Never wider than the terminal, so it doesn't wrap.
  const { columns } = useWindowSize();
  const fitted = width === undefined ? undefined : Math.min(width, columns - 2);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tone} paddingX={1} width={fitted} alignSelf="center">
      <Text bold color={tone}>
        {title}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {children}
      </Box>
    </Box>
  );
}
