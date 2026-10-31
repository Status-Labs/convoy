import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import { isValidProjectName } from "@agent-platform/core";
import { Key } from "./key";

export interface ProjectPickerProps {
  /** Known projects with how many VMs each has. */
  projects: { name: string; vms: number }[];
  totalVms: number;
  /** null = all projects. */
  current: string | null;
  onPick: (project: string | null) => void;
  onCreate: (project: string) => void;
  onCancel: () => void;
}

const NEW = Symbol("new");

export function ProjectPicker({ projects, totalVms, current, onPick, onCreate, onCancel }: ProjectPickerProps) {
  const items: (string | null | typeof NEW)[] = [null, ...projects.map((p) => p.name), NEW];
  const [cursor, setCursor] = useState(Math.max(0, items.indexOf(current)));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useInput(
    (input, key) => {
      if (key.escape) return onCancel();
      if (key.upArrow || input === "k") return setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow || input === "j") return setCursor((c) => Math.min(items.length - 1, c + 1));
      if (key.return) {
        const item = items[cursor]!;
        if (item === NEW) return setCreating(true);
        onPick(item);
      }
    },
    { isActive: !creating },
  );

  useInput(
    (_input, key) => {
      if (key.escape) {
        setCreating(false);
        setError(null);
      }
    },
    { isActive: creating },
  );

  return (
    <Box flexDirection="column">
      <Text bold>Projects</Text>
      <Box marginTop={1} flexDirection="column">
        {items.map((item, index) => {
          const isCursor = index === cursor && !creating;
          const label = item === null ? "All projects" : item === NEW ? "+ New project" : item;
          const count =
            item === null ? totalVms : item === NEW ? null : (projects.find((p) => p.name === item)?.vms ?? 0);
          return (
            <Box key={String(label)}>
              <Text color="cyan">{isCursor ? "❯ " : "  "}</Text>
              <Box width={34}>
                <Text bold={isCursor} color={item === NEW ? "cyan" : undefined}>
                  {label}
                  {item === current ? " ✓" : ""}
                </Text>
              </Box>
              {count !== null && <Text dimColor>{count === 1 ? "1 VM" : `${count} VMs`}</Text>}
            </Box>
          );
        })}
      </Box>

      {creating ? (
        <Box marginTop={1} flexDirection="column">
          <Box gap={1}>
            <Text>Name:</Text>
            <TextInput
              placeholder="e.g. my-app"
              onSubmit={(value) => {
                const name = value.trim();
                if (!isValidProjectName(name)) {
                  setError("Use lowercase letters, digits and dashes (max 30), starting with a letter or digit.");
                  return;
                }
                onCreate(name);
              }}
            />
          </Box>
          {error && <Text color="red">{error}</Text>}
          <Box marginTop={1} gap={2}>
            <Key k="⏎" label="create" />
            <Key k="esc" label="back" />
          </Box>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>New VMs launch into the selected project. VMs keep their project on the cloud provider.</Text>
          <Box marginTop={1} gap={2}>
            <Key k="⏎" label="switch" />
            <Key k="esc" label="back" />
          </Box>
        </Box>
      )}
    </Box>
  );
}
