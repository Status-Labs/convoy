# Signing in agent tools on VMs

When you launch VMs, you choose how their agent tools sign in:

| | Sign in yourself (default) | API keys from .env |
| :- | :- | :- |
| For | Using your Claude or ChatGPT plan on a few VMs | Swarms: many VMs, unattended agents |
| How | Press `l` on the VM in the TUI (or `pnpm cli login <vm>`) and finish each tool's own login in your browser | Keys are installed on boot; tools work immediately |
| Billing | Your plan's usage limits | Per-token API billing |

Subscription logins are never copied between machines: each VM signs in through Anthropic's and OpenAI's own login flows. That keeps agent-vm within each vendor's terms and guidance (details below).

## Sign in yourself

After the VM is ready, select it in the TUI and press `l`, or run `pnpm cli login <vm>`. This opens a terminal on the VM that runs, for each installed tool that isn't signed in yet:

- **Claude Code**: `claude auth login`. Open the link in your browser, sign in, and paste the code back if asked.
- **Codex**: `codex login --device-auth`. Open the link on any device and enter the code. Device code login must first be turned on in your ChatGPT security settings.
- **OpenCode**: run `opencode auth login` on the VM yourself.

Subscription plans' limits "assume ordinary, individual usage", so for many VMs running agents at once, use API keys.

## API keys

Add the keys you want to `.env`:

```sh
ANTHROPIC_API_KEY=sk-ant-...   # from https://platform.claude.com
OPENAI_API_KEY=sk-...          # from https://platform.openai.com
```

Then choose **API keys from .env** at the sign-in step (`pnpm cli create --api-keys` on the command line). New VMs get the keys automatically after setup finishes. To apply keys to a VM that already exists, or after changing a key:

```sh
pnpm cli keys <vm>
```

| Tool | With a key | Without a key |
| :- | :- | :- |
| Claude Code | Uses `ANTHROPIC_API_KEY` | **Can't be selected** in API-key mode. Add a key, or sign in yourself |
| Codex CLI | Uses `OPENAI_API_KEY` | Installed; sign in on the VM with `l` |
| OpenCode | Uses whichever keys are set | Installed; `opencode auth login` on the VM |
| agent-browser | Needs no key | |

In the TUI, the tools step shows how each tool will sign in.

## Why Claude logins aren't copied

Anthropic's [Claude Code legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) says subscription (OAuth) logins are for ordinary use of Claude Code, and that developers "may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow." agent-vm copying a Claude login to many VMs would be that kind of tool, so it never does. API keys are explicitly fine to put in "a development environment, secrets manager, or machine image" for your own use, billed to you.

Signing in yourself on each VM goes through Anthropic's own flow, and agent-vm never sees the token. That's the "Sign in yourself" mode.

## Codex with a ChatGPT plan

OpenAI documents copying `~/.codex/auth.json` to a headless machine, but its [CI/CD auth guide](https://learn.chatgpt.com/docs/auth/ci-cd-auth.md) says: "Do not share the same file across concurrent jobs or multiple machines." Codex refreshes the login and writes it back, so copies on other VMs stop working. agent-vm therefore doesn't copy it; each VM signs in on its own with "Sign in yourself". OpenAI's guide also says "the right way to authenticate automation is with an API key".

## How keys are stored on the VM

- Keys are sent over SSH on stdin after setup finishes. They never go into the cloud provider's VM setup data (cloud-init user data), which the provider stores and any process on the VM can read from the metadata service.
- They're saved in `~/.config/agent-vm/` on the VM, readable only by the `agent` user (mode 600).
- **Claude Code** reads the key through `apiKeyHelper` in `~/.claude/settings.json`, so the key isn't in the environment of every process, and Claude Code doesn't ask to approve it.
- **Codex** stores it with `codex login --with-api-key`.
- **OpenCode** reads the key files through `{file:...}` references in `~/.config/opencode/opencode.json`.

Anyone who gets into a VM, including an agent running there, can read these keys. Use keys with spending limits, and rotate them in the provider's console if a VM may have been compromised. Snapshots of a VM include the keys.
