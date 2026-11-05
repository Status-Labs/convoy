import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import { isValidProjectName, parseRepo, repoSlug } from "@agent-platform/core";
import { Key } from "./key";

export interface ProjectPickerProps {
  /** Known projects with how many VMs each has. */
  projects: { name: string; vms: number }[];
  totalVms: number;
  /** null = all projects. */
  current: string | null;
  onPick: (project: string | null) => void;
  onCreate: (project: string) => void;
  /** The project's GitHub repos (owner/name), cloned onto its new VMs. */
  repos: (project: string) => string[];
  onSaveRepos: (project: string, repos: string[]) => void;
  onCancel: () => void;
}

const NEW = Symbol("new");

export function ProjectPicker({ projects, totalVms, current, onPick, onCreate, repos, onSaveRepos, onCancel }: ProjectPickerProps) {
  const items: (string | null | typeof NEW)[] = [null, ...projects.map((p) => p.name), NEW];
  const [cursor, setCursor] = useState(Math.max(0, items.indexOf(current)));
  const [creating, setCreating] = useState(false);
  // The project whose repos are being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped on save so the repo column re-reads prefs.
  const [, setSaved] = useState(0);

  useInput(
    (input, key) => {
      if (key.escape) return onCancel();
      if (key.upArrow || input === "k") return setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow || input === "j") return setCursor((c) => Math.min(items.length - 1, c + 1));
      const item = items[cursor]!;
      if (input === "e" && typeof item === "string") return setEditing(item);
      if (key.return) {
        if (item === NEW) return setCreating(true);
        onPick(item);
      }
    },
    { isActive: !creating && !editing },
  );

  useInput(
    (_input, key) => {
      if (key.escape) {
        setCreating(false);
        setEditing(null);
        setError(null);
      }
    },
    { isActive: creating || editing !== null },
  );

  const saveRepos = (project: string, value: string) => {
    const slugs: string[] = [];
    for (const part of value.split(/[\s,]+/).filter(Boolean)) {
      try {
        slugs.push(repoSlug(parseRepo(part)));
      } catch (err) {
        return setError((err as Error).message);
      }
    }
    onSaveRepos(project, [...new Set(slugs)]);
    setSaved((n) => n + 1);
    setEditing(null);
    setError(null);
  };

  return (
    <Box flexDirection="column">
      <Text bold>Projects</Text>
      <Box marginTop={1} flexDirection="column">
        {items.map((item, index) => {
          const isCursor = index === cursor && !creating && !editing;
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
              <Box width={8}>{count !== null && <Text dimColor>{count === 1 ? "1 VM" : `${count} VMs`}</Text>}</Box>
              {typeof item === "string" && repos(item).length > 0 && (
                <Text dimColor wrap="truncate-end">
                  repos: {repos(item).join(", ")}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>

      {editing ? (
        <Box marginTop={1} flexDirection="column">
          <Text>
            GitHub repos for <Text bold>{editing}</Text>, cloned into the home directory of each new VM in it:
          </Text>
          <Box gap={1}>
            <Text>Repos:</Text>
            <TextInput
              defaultValue={repos(editing).join(" ")}
              placeholder="owner/repo owner/other (space or comma separated)"
              onSubmit={(value) => saveRepos(editing, value)}
            />
          </Box>
          {error && <Text color="red">{error}</Text>}
          <Text dimColor>Private repos need GITHUB_TOKEN in .env (see docs/github.md).</Text>
          <Box marginTop={1} gap={2}>
            <Key k="⏎" label="save" />
            <Key k="esc" label="back" />
          </Box>
        </Box>
      ) : creating ? (
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
            <Key k="e" label="edit repos" />
            <Key k="esc" label="back" />
          </Box>
        </Box>
      )}
    </Box>
  );
}
