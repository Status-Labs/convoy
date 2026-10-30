// Agent tools users can pick when creating a VM. To add a tool, add an entry
// here: `install` runs as the `agent` user with ~/.local/bin on PATH and npm's
// global prefix set to ~/.local, so tools can update themselves without sudo.

export interface AgentTool {
  id: string;
  name: string;
  description: string;
  /** Shell command(s), run with bash as the agent user. */
  install: string;
  /** Binary that must be on PATH afterwards, used to verify the install. */
  bin: string;
}

export const AGENT_TOOLS = [
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Anthropic's coding agent",
    install: "curl -fsSL https://claude.ai/install.sh | bash",
    bin: "claude",
  },
  {
    id: "codex",
    name: "Codex CLI",
    description: "OpenAI's coding agent",
    install: "npm install -g @openai/codex",
    bin: "codex",
  },
  {
    id: "agent-browser",
    name: "agent-browser",
    description: "Browser automation CLI for agents (Vercel)",
    install: "npm install -g agent-browser && agent-browser install --with-deps",
    bin: "agent-browser",
  },
  {
    id: "opencode",
    name: "OpenCode",
    description: "Open source coding agent",
    install: "npm install -g opencode-ai",
    bin: "opencode",
  },
] as const satisfies readonly AgentTool[];

export type ToolId = (typeof AGENT_TOOLS)[number]["id"];

export const ALL_TOOL_IDS: ToolId[] = AGENT_TOOLS.map((tool) => tool.id);

export function parseToolIds(ids: string[]): ToolId[] {
  const unknown = ids.filter((id) => !ALL_TOOL_IDS.includes(id as ToolId));
  if (unknown.length > 0) {
    throw new Error(`Unknown tool(s): ${unknown.join(", ")}. Available: ${ALL_TOOL_IDS.join(", ")}`);
  }
  return ids as ToolId[];
}
