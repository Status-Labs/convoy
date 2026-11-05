# GitHub on agent VMs

Every VM has `git` and GitHub's CLI (`gh`). Public repos clone with no setup. For private repos and pushing, give the VMs a GitHub token, or sign in on a VM yourself.

## Give VMs a token (recommended)

1. Create a **fine-grained personal access token** at <https://github.com/settings/personal-access-tokens/new>:
   - **Repository access:** only the repos agents need.
   - **Permissions:** *Contents: Read and write*. Add *Pull requests: Read and write* if agents should open PRs.
   - **Expiration:** pick one; you can make a new token later.
2. Put it in `.env`:
   ```sh
   GITHUB_TOKEN=github_pat_...
   ```

New VMs get it after setup, in either sign-in mode: a GitHub token isn't a Claude or ChatGPT login. For a VM that already exists, or after changing the token:

```sh
pnpm cli keys <vm>
```

On the VM, `gh` is signed in with the token and git uses it for `https://github.com/...` URLs, so plain `git clone`, `git pull` and `git push` work, and so does `gh pr create`.

## Or sign in on a VM yourself

Press `l` on the VM (or `pnpm cli login <vm>`). If `gh` isn't signed in, it asks whether to sign in to GitHub, then gives you a code to enter at github.com. This gives the VM access to every repo your account can reach, so prefer a fine-grained token for VMs that run agents unattended.

## Commits are yours

agent-vm copies `user.name` and `user.email` from your local git config to each VM, so commits made there are attributed to you. If they aren't set locally, set them (`git config --global user.name "…"`), then run `pnpm cli keys <vm>`.

## Clone repos

**Per project.** List a project's repos and every new VM launched into that project clones them into its home directory (`~/<repo>`):

```sh
pnpm cli repos my-app add my-org/api        # or a github.com URL
pnpm cli repos my-app add my-org/web
pnpm cli repos my-app                       # list
pnpm cli repos my-app remove my-org/web
```

In the TUI: `p` to open projects, select one, `e` to edit its repos.

A repo that can't be cloned (a typo, or private without access) doesn't stop the launch: you get a message with the command to retry. A directory that already exists is left alone.

**One-off:**

```sh
pnpm cli clone <vm> my-org/api [dir]
```

SSH URLs (`git@github.com:owner/repo.git`) are cloned over https so the token applies.

## Security notes

- **Limit the token.** With write access, an agent can push. Restrict the token to the repos agents need, give it an expiry, and turn on branch protection for `main` so agents push to branches and open pull requests.
- Anyone who gets into the VM, including an agent, can read the token (`gh auth token`), like the API keys.
- The token is sent over SSH on stdin. It never goes into the cloud provider's setup data, command-line arguments or clone URLs, so it isn't in `.git/config` or shell history. gh stores it in `~/.config/gh/hosts.yml` (readable only by `agent`).
- **Snapshots include it**, as do sleeping VMs.
- To rotate: make a new token, update `.env`, run `pnpm cli keys <vm>` on each VM, then delete the old token on GitHub.
