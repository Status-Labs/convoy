import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Spinner } from "@inkjs/ui";
import { formatCost, type FleetSnapshot } from "@agent-platform/core";
import { Key } from "./key";

export interface SnapshotListProps {
  /** null while loading. */
  snapshots: FleetSnapshot[] | null;
  providerLabels: Record<string, string>;
  /** Snapshot ids being deleted. */
  deleting: Set<string>;
  onLaunch: (snapshot: FleetSnapshot) => void;
  onDelete: (snapshot: FleetSnapshot) => void;
  onRefresh: () => void;
  onBack: () => void;
  onQuit: () => void;
}

function age(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

const COLUMNS = { name: 32, from: 17, project: 11, data: 8, regions: 10, cost: 9 };

/** Saved snapshots: launch a copy, or delete. */
export function SnapshotList({ snapshots, providerLabels, deleting, onLaunch, onDelete, onRefresh, onBack, onQuit }: SnapshotListProps) {
  const [cursor, setCursor] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<FleetSnapshot | null>(null);
  const list = snapshots ?? [];
  const current = Math.min(cursor, list.length - 1);

  useInput((input, key) => {
    if (confirmDelete) {
      if (input.toLowerCase() === "y") onDelete(confirmDelete);
      return setConfirmDelete(null);
    }
    if (key.tab || key.escape) return onBack();
    if (input === "q") return onQuit();
    if (input === "r") return onRefresh();
    if (key.upArrow || input === "k") return setCursor(Math.max(0, current - 1));
    if (key.downArrow || input === "j") return setCursor(Math.min(list.length - 1, current + 1));
    const snapshot = list[current];
    if (!snapshot || deleting.has(snapshot.id)) return;
    if (key.return) return onLaunch(snapshot);
    if (input === "d") return setConfirmDelete(snapshot);
  });

  const total = list.reduce((sum, s) => sum + (s.monthly ?? 0), 0);

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>Snapshots</Text>
        {list.length > 0 && (
          <Text dimColor>
            {"  "}
            {list.length} saved · {formatCost(total)}/month storage
          </Text>
        )}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {snapshots === null ? (
          <Spinner label="Loading snapshots…" />
        ) : list.length === 0 ? (
          <Text>
            No snapshots yet. Select a running VM and press <Text bold color="cyan">b</Text> to save one, then launch copies of it
            from here.
          </Text>
        ) : (
          <>
            <Text dimColor>
              {"  "}
              {"NAME".padEnd(COLUMNS.name)}
              {"FROM".padEnd(COLUMNS.from)}
              {"PROJECT".padEnd(COLUMNS.project)}
              {"DATA".padEnd(COLUMNS.data)}
              {"REGION".padEnd(COLUMNS.regions)}
              {"$/MO".padEnd(COLUMNS.cost)}
              AGE
            </Text>
            {list.map((s, index) => {
              const isCursor = index === current;
              return (
                <Box key={s.id}>
                  <Text color="cyan">{isCursor ? "❯ " : "  "}</Text>
                  <Box width={COLUMNS.name}>
                    <Text bold={isCursor} wrap="truncate-end">
                      {s.name}
                    </Text>
                  </Box>
                  <Box width={COLUMNS.from}>
                    <Text wrap="truncate-end">{s.sourceVm ?? "—"}</Text>
                  </Box>
                  <Box width={COLUMNS.project}>
                    <Text wrap="truncate-end" dimColor={!s.project}>
                      {s.project ?? "—"}
                    </Text>
                  </Box>
                  <Box width={COLUMNS.data}>
                    <Text>{`${s.sizeGb} GB`}</Text>
                  </Box>
                  <Box width={COLUMNS.regions}>
                    <Text wrap="truncate-end">{s.regions.join(" ")}</Text>
                  </Box>
                  <Box width={COLUMNS.cost}>
                    <Text>{s.monthly === null ? "—" : formatCost(s.monthly)}</Text>
                  </Box>
                  {deleting.has(s.id) ? <Spinner label="deleting" /> : <Text dimColor>{age(s.createdAt)}</Text>}
                </Box>
              );
            })}
          </>
        )}
      </Box>

      <Box marginTop={1}>
        {confirmDelete ? (
          <Text color="yellow">
            Delete snapshot {confirmDelete.name}? VMs launched from it are unaffected. <Text bold>y/N</Text>
          </Text>
        ) : list[current] ? (
          <Text dimColor>
            Enter launches a copy ({list[current]!.size ?? "same size"} in {list[current]!.regions[0]},{" "}
            {providerLabels[list[current]!.provider]}) with its tools, files and sign-ins.
          </Text>
        ) : (
          <Text> </Text>
        )}
      </Box>

      <Box marginTop={1} gap={2}>
        <Key k="⏎" label="launch copy" />
        <Key k="d" label="delete" />
        <Key k="r" label="refresh" />
        <Key k="tab" label="VMs" />
        <Key k="q" label="quit" />
      </Box>
    </Box>
  );
}
