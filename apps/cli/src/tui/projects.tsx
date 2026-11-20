import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import { formatCost, isValidProjectName, parseRepo, repoSlug } from "@convoy/core";
import { fit, Glyph, type Tone } from "./ui";

export interface ProjectSummary {
  name: string;
  /** VM count by state. */
  tones: Partial<Record<Tone, number>>;
  repos: string[];
  /** Month-to-date cost of its VMs. */
  cost: number;
}

export interface ProjectsProps {
  projects: ProjectSummary[];
  /** null = all projects. */
  current: string | null;
  width: number;
  onShow: (project: string | null) => void;
  onCreate: (project: string) => void;
  onSaveRepos: (project: string, repos: string[]) => void;
  onDelete: (project: string) => void;
  /** True while typing a name or repos or confirming, so app-wide keys stay off. */
  onEditing: (editing: boolean) => void;
}

type Mode = { kind: "list" } | { kind: "new" } | { kind: "repos"; project: string } | { kind: "delete"; project: string };

const TONE_ORDER: Tone[] = ["running", "working", "asleep", "stopped", "billed", "failed"];

/** Projects: what's in each, which repos its new VMs clone, and what it costs. */
export function Projects({ projects, current, width, onShow, onCreate, onSaveRepos, onDelete, onEditing }: ProjectsProps) {
  const [cursor, setCursor] = useState(Math.max(0, projects.findIndex((p) => p.name === current)));
  const [mode, setModeState] = useState<Mode>({ kind: "list" });
  const [error, setError] = useState<string | null>(null);
  const at = Math.min(cursor, Math.max(0, projects.length - 1));
  useEffect(() => () => onEditing(false), []);
  const selected = projects[at];

  const setMode = (next: Mode) => {
    setModeState(next);
    setError(null);
    onEditing(next.kind !== "list");
  };

  useInput(
    (input, key) => {
      if (mode.kind === "delete") {
        if (input.toLowerCase() === "y") onDelete(mode.project);
        return setMode({ kind: "list" });
      }
      if (key.upArrow || input === "k") return setCursor(Math.max(0, at - 1));
      if (key.downArrow || input === "j") return setCursor(Math.min(projects.length - 1, at + 1));
      if (input === "n") return setMode({ kind: "new" });
      if (input === "a") return onShow(null);
      if (!selected) return;
      if (key.return) return onShow(selected.name);
      if (input === "e") return setMode({ kind: "repos", project: selected.name });
      if (input === "d") {
        const vms = Object.values(selected.tones).reduce((a, b) => a + (b ?? 0), 0);
        if (vms > 0) return setError(`${selected.name} still has ${vms === 1 ? "a VM" : `${vms} VMs`}. Delete them first.`);
        return setMode({ kind: "delete", project: selected.name });
      }
    },
    { isActive: mode.kind === "list" || mode.kind === "delete" },
  );

  useInput((_input, key) => key.escape && setMode({ kind: "list" }), { isActive: mode.kind === "new" || mode.kind === "repos" });

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
    setMode({ kind: "list" });
  };

  const repoWidth = Math.max(20, width - 2 - 14 - 14 - 10);

  return (
    <Box flexDirection="column">
      {projects.length === 0 ? (
        <Text>
          No projects yet. A project groups VMs, e.g. one per codebase, and lists the repos its new VMs clone. Press{" "}
          <Text bold color="cyan">
            n
          </Text>{" "}
          to create one.
        </Text>
      ) : (
        <>
          <Text dimColor>
            {"  "}
            {fit("PROJECT", 14)}
            {fit("VMS", 14)}
            {fit("REPOS CLONED ON NEW VMS", repoWidth)}
            THIS MONTH
          </Text>
          {projects.map((p, i) => {
            const isCursor = i === at && mode.kind === "list";
            return (
              <Box key={p.name}>
                <Text color="cyan">{isCursor ? "❯ " : "  "}</Text>
                <Text bold={isCursor}>{fit(p.name + (p.name === current ? " ✓" : ""), 14)}</Text>
                <Box width={14}>
                  {TONE_ORDER.filter((t) => p.tones[t]).length === 0 ? (
                    <Text dimColor>0</Text>
                  ) : (
                    <Box columnGap={1}>
                      {TONE_ORDER.filter((t) => p.tones[t]).map((t) => (
                        <Text key={t}>
                          {p.tones[t]} <Glyph tone={t} />
                        </Text>
                      ))}
                    </Box>
                  )}
                </Box>
                <Text dimColor={p.repos.length === 0}>{fit(p.repos.length > 0 ? p.repos.join("  ") : "—", repoWidth)}</Text>
                <Text>{formatCost(p.cost)}</Text>
              </Box>
            );
          })}
        </>
      )}

      <Box marginTop={1} flexDirection="column">
        {mode.kind === "new" ? (
          <Box gap={1}>
            <Text>New project name:</Text>
            <TextInput
              placeholder="e.g. my-app"
              onSubmit={(value) => {
                const name = value.trim();
                if (!isValidProjectName(name)) {
                  return setError("Use lowercase letters, digits and dashes (max 30), starting with a letter or digit.");
                }
                onCreate(name);
                setMode({ kind: "list" });
              }}
            />
          </Box>
        ) : mode.kind === "repos" ? (
          <>
            <Text>
              GitHub repos for <Text bold>{mode.project}</Text>, cloned into the home directory of each new VM in it.
              Private repos need GITHUB_TOKEN in .env.
            </Text>
            <Box gap={1}>
              <Text>Repos:</Text>
              <TextInput
                defaultValue={projects.find((p) => p.name === mode.project)?.repos.join(" ") ?? ""}
                placeholder="owner/repo owner/other"
                onSubmit={(value) => saveRepos(mode.project, value)}
              />
            </Box>
          </>
        ) : mode.kind === "delete" ? (
          <Text color="yellow">
            Forget project {mode.project} and its repo list? <Text bold>y/N</Text>
          </Text>
        ) : (
          <Text dimColor>
            Showing {current ? <Text bold>{current}</Text> : "all projects"}. ⏎ shows only the selected project, and new
            VMs launch into it.
          </Text>
        )}
        {error ? <Text color="red">{error}</Text> : null}
      </Box>
    </Box>
  );
}
