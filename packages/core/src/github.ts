// GitHub access from agent VMs: the GitHub CLI on every VM, an optional
// fine-grained token from .env (GITHUB_TOKEN) wired into git, the user's
// commit identity, and repos cloned per project. See docs/github.md.

/** Root commands that install GitHub's CLI from its signed apt repository. */
export const GH_INSTALL = [
  "install -d -m 0755 /etc/apt/keyrings",
  "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg",
  "chmod 644 /etc/apt/keyrings/githubcli-archive-keyring.gpg",
  'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list',
  "apt-get update -q",
  "apt-get install -y -q gh",
].join("\n");

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Bash lines, run as the agent user, that sign gh in with a token and make
 * plain `git clone`/`push` over https use it. The token goes in on stdin and
 * is stored only by gh (~/.config/gh/hosts.yml, mode 600). Installs gh first
 * on VMs launched before it was in the base setup.
 */
export function githubTokenLines(token: string): string[] {
  return [
    `if ! command -v gh >/dev/null; then sudo bash -c ${shellQuote(GH_INSTALL)} >/dev/null; fi`,
    // printf is a builtin, so the token never shows up in a process listing.
    `if ! out=$(printf '%s\\n' ${shellQuote(token)} | gh auth login --hostname github.com --git-protocol https --with-token 2>&1); then`,
    `  echo "GitHub didn't accept GITHUB_TOKEN: $(printf '%s' "$out" | head -n1)" >&2; exit 1`,
    "fi",
    "gh auth setup-git --hostname github.com",
  ];
}

export interface GitIdentity {
  name: string;
  email: string;
}

/** Bash lines that set the commit author for the agent user. */
export function gitIdentityLines({ name, email }: GitIdentity): string[] {
  return [`git config --global user.name ${shellQuote(name)}`, `git config --global user.email ${shellQuote(email)}`];
}

export interface RepoRef {
  owner: string;
  name: string;
}

const NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * Parses owner/repo, an https URL or a git@github.com: URL. SSH URLs become
 * https so the token from gh's credential helper applies.
 */
export function parseRepo(input: string): RepoRef {
  const trimmed = input.trim();
  const match =
    /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
      trimmed,
    );
  const owner = match?.[1];
  const name = match?.[2];
  if (!owner || !name || !NAME.test(owner) || !NAME.test(name) || name === "." || name === "..") {
    throw new Error(`"${input}" isn't a GitHub repo. Use owner/repo or a github.com URL.`);
  }
  return { owner, name };
}

export function repoSlug({ owner, name }: RepoRef): string {
  return `${owner}/${name}`;
}

/**
 * Bash script, run as the agent user, that clones each repo into ~/<dir>
 * unless the directory exists. Never prompts for a password: a repo it can't
 * reach fails fast. Prints one line per repo: `ok <slug>`, `skip <slug>` or
 * `fail <slug> <reason>`; exits 0 even when some fail.
 */
export function cloneScript(repos: { repo: RepoRef; dir?: string }[]): string {
  const lines = ["export GIT_TERMINAL_PROMPT=0", "cd ~"];
  for (const { repo, dir = repo.name } of repos) {
    if (!NAME.test(dir) || dir === "." || dir === "..") throw new Error(`Invalid directory name "${dir}"`);
    const slug = shellQuote(repoSlug(repo));
    const target = shellQuote(dir);
    lines.push(
      `if [ -e ${target} ]; then echo "skip "${slug}`,
      `elif out=$(git clone --quiet https://github.com/${repo.owner}/${repo.name}.git ${target} 2>&1); then echo "ok "${slug}`,
      `else echo "fail "${slug}" $(printf '%s' "$out" | grep -v '^Cloning' | tail -n 1)"; fi`,
    );
  }
  return lines.join("\n") + "\n";
}

export interface CloneResult {
  repo: string;
  status: "ok" | "skip" | "fail";
  reason?: string;
}

// git asks for a password when a repo doesn't exist or is private and the VM
// has no access; with prompts off, that's the error it prints.
function cloneFailure(reason: string | undefined): string | undefined {
  if (reason?.includes("could not read Username")) return "not found, or private and the VM has no GitHub access";
  return reason || undefined;
}

export function parseCloneOutput(stdout: string): CloneResult[] {
  return stdout
    .split("\n")
    .map((line) => /^(ok|skip|fail) (\S+)(?: (.*))?$/.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(([, status, repo, reason]) => ({ repo: repo!, status: status as CloneResult["status"], reason: cloneFailure(reason) }));
}

/** The interactive part of SIGN_IN_SCRIPT for GitHub (device-code sign-in, opt-in). */
export const GITHUB_SIGN_IN = `
if command -v gh >/dev/null; then
  if gh auth status --hostname github.com >/dev/null 2>&1; then
    echo "GitHub: already signed in as $(gh api user --jq .login 2>/dev/null || echo "you")."
  else
    echo
    read -rp "Sign in to GitHub so agents can clone and push your repos? [y/N] " answer
    if [ "\${answer,,}" = y ]; then
      echo "(This gives the VM access to all your repos. For narrower access, use GITHUB_TOKEN in .env.)"
      if gh auth login --hostname github.com --git-protocol https --web; then
        gh auth setup-git --hostname github.com
      else
        echo "GitHub sign-in didn't finish. Retry on the VM with: gh auth login --web && gh auth setup-git"
      fi
    fi
  fi
fi
`;
