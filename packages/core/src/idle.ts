// Auto-sleep: a VM that has been idle for a while is put to sleep, so a
// forgotten VM costs storage instead of compute. The watcher runs on the
// user's machine (the TUI while it's open, or `agent-vm autosleep watch`)
// and checks VMs over SSH; nothing on the VM can sleep it, so no cloud token
// ever goes onto a VM.

/** Minutes of idleness before auto-sleep, unless the user picks another. */
export const DEFAULT_AUTOSLEEP_MINUTES = 30;

/** How often the watcher checks each opted-in VM. */
export const IDLE_CHECK_MS = 5 * 60_000;

/**
 * Prints why the VM is busy (one reason per line), or nothing if it's idle.
 * Busy means any of: someone logged in over SSH (besides this check), a
 * desktop viewer connected, an agent tool running, a program running in
 * tmux, or CPU in use. Run as the agent user.
 */
export const IDLE_CHECK_SCRIPT = `
export PATH="$HOME/.local/bin:$PATH"
# SSH logins with a terminal; this check runs without one. tmux windows show
# up in who too, but they're judged by what runs in them (below).
n=$(who | grep -vc '(tmux'); [ "$n" -gt 0 ] && echo "$n SSH session(s)"
# Viewers on the desktop (KasmVNC on 8444) or anything served to the tailnet.
v=$(ss -Htn state established '( sport = :8444 )' 2>/dev/null | wc -l); [ "$v" -gt 0 ] && echo "desktop in use"
# By command line: some are node scripts, some native binaries.
for p in claude codex opencode agent-browser; do pgrep -f "(^|/)$p( |$)" >/dev/null && echo "$p running"; done
pgrep -f '[.]agent-browser/browsers/.*/chrome' >/dev/null && echo "agent browser open"
# Programs left running in tmux (an idle shell prompt doesn't count).
tmux list-panes -a -F '#{pane_current_command}' 2>/dev/null | grep -vxE '(ba|z|da|fi)?sh|tmux' | sort -u | sed 's/$/ running in tmux/'
# 5-minute load average, as a share of one core.
awk -v cores="$(nproc)" '{ if ($2 / cores > 0.15) printf "CPU busy (load %s)\\n", $2 }' /proc/loadavg
true
`;

/** Reasons the VM is busy; empty when idle. */
export function parseIdleCheck(stdout: string): string[] {
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** "30m", "2h", "90" (minutes) → minutes; "off" → null. */
export function parseIdleMinutes(value: string): number | null {
  if (value === "off") return null;
  const match = /^(\d+)\s*(m|min|h)?$/.exec(value.trim());
  if (!match) throw new Error(`"${value}" isn't a duration: use e.g. 30m, 2h, or off.`);
  const minutes = Number(match[1]) * (match[2] === "h" ? 60 : 1);
  if (minutes < 10) throw new Error("Use at least 10 minutes, so a VM isn't put to sleep while you step away briefly.");
  return minutes;
}

export function formatMinutes(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}
