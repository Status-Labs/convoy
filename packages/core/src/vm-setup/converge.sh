#!/bin/bash
# Brings a VM to the current Convoy setup: the security baseline, Node.js,
# the GitHub and GitLab CLIs, and the agent tools listed in /etc/convoy/tools.
# Runs as root at first boot (from bootstrap.sh) and again by `convoy update`,
# so every step must be safe to repeat: a second run changes nothing.
set -euo pipefail

AGENT_USER=agent
AGENT_HOME=/home/$AGENT_USER
STATE_DIR=/var/lib/convoy
LIB=/usr/local/lib/convoy
NODE_MAJOR=22

# Shared with bootstrap.sh when it sources this file; standalone otherwise.
if ! declare -F log >/dev/null; then
  log() { echo "[convoy] $*"; }
  phase() { :; }
fi

# No interactive prompts from apt or needrestart (e.g. "pending kernel upgrade").
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1

# Run a command as the agent user, with ~/.local/bin (npm prefix) on PATH.
# runuser, not sudo: sudo refuses to run while root's password is expired.
as_agent() {
  runuser -u "$AGENT_USER" -- env HOME="$AGENT_HOME" USER="$AGENT_USER" \
    bash -c 'cd ~ && export PATH="$HOME/.local/bin:$PATH" && '"$1"
}

mkdir -p "$STATE_DIR" /etc/convoy

# One-off steps for VMs set up by an older Convoy (see migrations/README.md).
applied=$(cat /etc/convoy/migration 2>/dev/null || echo 0)
for script in "$LIB"/migrations/[0-9]*.sh; do
  [ -e "$script" ] || continue
  number=$(basename "$script" | cut -d- -f1)
  if [ $((10#$number)) -gt $((10#$applied)) ]; then
    log "migration $(basename "$script" .sh)"
    bash "$script"
    echo "$number" > /etc/convoy/migration
    applied=$number
  fi
done
echo "$applied" > /etc/convoy/migration

phase "securing the VM"
log "installing base packages"
apt-get update -q
apt-get install -y -q \
  ufw fail2ban python3-systemd unattended-upgrades \
  git curl ca-certificates unzip build-essential python3 python3-pip python3-venv ripgrep jq tmux

log "hardening ssh"
# sshd -t needs /run/sshd, which doesn't exist while ssh is socket-activated
# and idle (the default after some openssh upgrades on Ubuntu 24.04).
install -d -m 0755 /run/sshd
sshd -t
# Restart only if running; otherwise the next connection starts sshd with
# the new config. Open sessions stay up.
systemctl try-restart ssh.service

log "applying kernel network hardening"
sysctl --system >/dev/null

# Keeps Chrome's sandbox working for agent browsers instead of --no-sandbox.
log "loading AppArmor profile for agent browsers"
apparmor_parser -r /etc/apparmor.d/convoy-chrome

log "configuring firewall (inbound: ssh only)"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp comment 'ssh' >/dev/null
if command -v tailscale >/dev/null; then ufw allow in on tailscale0 comment 'tailnet' >/dev/null; fi
# Keeps ports opened with `convoy expose`.
convoy-firewall apply-docker-rules
ufw --force enable >/dev/null
ufw reload >/dev/null

log "enabling fail2ban and automatic security updates"
systemctl enable --now fail2ban
systemctl reload-or-restart fail2ban
systemctl enable --now unattended-upgrades

phase "adding Node.js"
if [ "$(node -v 2>/dev/null | cut -d. -f1)" != "v$NODE_MAJOR" ]; then
  log "installing Node.js $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_$NODE_MAJOR.x" | bash -
fi
apt-get install -y -q nodejs

log "preparing $AGENT_USER's environment"
as_agent 'mkdir -p ~/.local/bin && npm config set prefix ~/.local'
# Prepend (not append) so non-interactive ssh commands see the tools too;
# Ubuntu's .bashrc returns early for non-interactive shells.
grep -qxF 'export PATH="$HOME/.local/bin:$PATH"' "$AGENT_HOME/.bashrc" ||
  as_agent "sed -i '1i export PATH=\"\$HOME/.local/bin:\$PATH\"' ~/.bashrc"

# install_gh, install_glab and install_tool, generated from tools.ts.
# shellcheck source=/dev/null
. "$LIB/tools.sh"

phase "adding GitHub CLI"
log "installing GitHub CLI"
install_gh

phase "adding GitLab CLI"
log "installing GitLab CLI"
install_glab

if command -v tailscale >/dev/null; then
  log "updating Tailscale"
  apt-get install -y -q tailscale
fi

if [ -f /etc/systemd/system/convoy-desktop.service ]; then
  phase "updating desktop"
  log "updating desktop"
  bash "$LIB/desktop.sh"
fi

# Read up front: installers may read stdin.
touch /etc/convoy/tools
mapfile -t tools < /etc/convoy/tools
for tool in "${tools[@]}"; do
  if [ -n "$tool" ]; then install_tool "$tool"; fi
done

cp "$LIB/setup-version" /etc/convoy/version
date -u +%FT%TZ > /etc/convoy/updated
log "setup version $(cat /etc/convoy/version)"
