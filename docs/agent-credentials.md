# Signing in agent tools on VMs

agent-vm can set up the agent tools on every new VM with your API keys, so you don't have to sign in on each VM by hand. Only API keys are automated. Subscription logins (Claude Pro/Max, ChatGPT plans) are never copied between machines, to stay within each vendor's terms and guidance.

## Setup

Add the keys you want to `.env`:

```sh
ANTHROPIC_API_KEY=sk-ant-...   # from https://platform.claude.com
OPENAI_API_KEY=sk-...          # from https://platform.openai.com
```

New VMs then get them automatically after setup finishes. To apply keys to a VM that already exists, or after changing a key:

```sh
pnpm cli keys <vm>
```

| Tool | With a key | Without a key |
| :- | :- | :- |
| Claude Code | Uses `ANTHROPIC_API_KEY` | **Can't be selected.** Add an API key to launch it |
| Codex CLI | Uses `OPENAI_API_KEY` | Installed; sign in on the VM (see below) |
| OpenCode | Uses whichever keys are set | Installed; sign in on the VM |
| agent-browser | Needs no key | |

In the TUI, the tools step shows how each tool will sign in.

## Why Claude Code requires an API key

Anthropic's [Claude Code legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) says subscription (OAuth) logins are for ordinary use of Claude Code, and that developers "may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow." agent-vm copying a Claude login to many VMs would be that kind of tool, so it never does. API keys are explicitly fine to put in "a development environment, secrets manager, or machine image" for your own use, billed to you.

Signing in yourself with `/login` inside Claude Code on a VM is your own use of Claude Code and isn't blocked, but agent-vm doesn't automate it. Keep in mind that subscription limits "assume ordinary, individual usage", so for several VMs running agents at once an API key is the right fit.

## Codex with a ChatGPT plan

OpenAI documents copying `~/.codex/auth.json` to a headless machine, but its [CI/CD auth guide](https://learn.chatgpt.com/docs/auth/ci-cd-auth.md) says: "Do not share the same file across concurrent jobs or multiple machines." Codex refreshes the login and writes it back, so copies on other VMs stop working. agent-vm therefore doesn't copy it. To use your ChatGPT plan, sign in once per VM:

```sh
pnpm cli ssh <vm>
codex login --device-auth   # open the link on any device and enter the code
```

Device code login must first be turned on in your ChatGPT security settings. OpenAI's guide also says "the right way to authenticate automation is with an API key".

## How keys are stored on the VM

- Keys are sent over SSH on stdin after setup finishes. They never go into the cloud provider's VM setup data (cloud-init user data), which the provider stores and any process on the VM can read from the metadata service.
- They're saved in `~/.config/agent-vm/` on the VM, readable only by the `agent` user (mode 600).
- **Claude Code** reads the key through `apiKeyHelper` in `~/.claude/settings.json`, so the key isn't in the environment of every process, and Claude Code doesn't ask to approve it.
- **Codex** stores it with `codex login --with-api-key`.
- **OpenCode** reads the key files through `{file:...}` references in `~/.config/opencode/opencode.json`.

Anyone who gets into a VM, including an agent running there, can read these keys. Use keys with spending limits, and rotate them in the provider's console if a VM may have been compromised. Snapshots of a VM include the keys.
