# MCP servers for agents

Give agents on every VM the same MCP servers, such as a task manager, from `.env`:

```sh
MCP_TASKS_URL=https://tasks.example.com/mcp
MCP_TASKS_TOKEN=...        # optional bearer token
```

Each `MCP_<NAME>_URL` is added to Claude Code and Codex for the `agent` user as `<name>` (lowercase, `_` becomes `-`), when a VM is launched in either sign-in mode. After changing `.env`, run `pnpm cli keys <vm>`: servers you removed from `.env` are removed from the VM too.

Only Streamable HTTP servers are supported. The server has to be reachable from the VM: on the internet, or on your tailnet if the VM joined it.

## Where the token goes

- It's copied over SSH, like the other keys, never in the cloud provider's setup data.
- On the VM it's only in `~/.config/convoy/env` (readable only by `agent`), which `~/.bashrc` loads as `MCP_<NAME>_TOKEN`. Claude Code's config has `Authorization: Bearer ${MCP_<NAME>_TOKEN}` and Codex's has `bearer_token_env_var`, so neither stores the token, and it's never on a command line.
- So the tools find the token when started from a shell on the VM (SSH, tmux, the desktop terminal). A program started some other way needs to load that file first.
- Anyone on the VM, including an agent, can read it. Give each VM or agent its own token where the server allows it, and revoke it when the VM is deleted. Snapshots include it.
