#!/bin/bash
# Runs once as root at first boot (from cloud-init runcmd), after packages are
# upgraded and the config files from write_files are in place. Applies the
# security baseline, then installs the agent tools the user picked.
set -euo pipefail

AGENT_USER=agent
AGENT_HOME=/home/$AGENT_USER
STATE_DIR=/var/lib/agent-vm

step="starting"
log() {
  step="$*"
  echo "[agent-vm] $*"
}
# A short label for the CLI's progress display (it reads $STATE_DIR/phase).
phase() {
  echo "$*" > "$STATE_DIR/phase"
}

# The CLI reads these markers to report the outcome; cloud-init's own status
# isn't reliable after a reboot.
mkdir -p "$STATE_DIR"
rm -f "$STATE_DIR/ready" "$STATE_DIR/failed"
phase "securing the VM"
trap 'rc=$?; if [ "$rc" -ne 0 ]; then echo "$step" > "$STATE_DIR/failed"; fi' EXIT

# No interactive prompts from apt or needrestart (e.g. "pending kernel upgrade").
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1

# Run a command as the agent user, with ~/.local/bin (npm prefix) on PATH.
# runuser, not sudo: sudo refuses to run while root's password is expired.
as_agent() {
  runuser -u "$AGENT_USER" -- env HOME="$AGENT_HOME" USER="$AGENT_USER" \
    bash -c 'cd ~ && export PATH="$HOME/.local/bin:$PATH" && '"$1"
}

# DigitalOcean gives root an expired password when no SSH keys are passed via
# its API, which breaks sudo and cron for root. Root never logs in here, so
# lock the password and clear the forced change.
log "locking root password"
usermod -L root
chage -d "$(date +%F)" -M -1 root

log "hardening ssh"
# sshd -t needs /run/sshd, which doesn't exist while ssh is socket-activated
# and idle (the default after some openssh upgrades on Ubuntu 24.04).
install -d -m 0755 /run/sshd
sshd -t
# Restart only if running; otherwise the next connection starts sshd with
# the new config.
systemctl try-restart ssh.service

log "applying kernel network hardening"
sysctl --system >/dev/null

# Keeps Chrome's sandbox working for agent browsers instead of --no-sandbox.
log "loading AppArmor profile for agent browsers"
apparmor_parser -r /etc/apparmor.d/agent-vm-chrome

log "configuring firewall (inbound: ssh only)"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'ssh'
agent-vm-firewall apply-docker-rules
ufw --force enable

log "enabling fail2ban and automatic security updates"
systemctl enable --now fail2ban
systemctl restart fail2ban
systemctl enable --now unattended-upgrades

phase "adding Node.js"
log "installing Node.js"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

log "preparing $AGENT_USER's environment"
as_agent 'mkdir -p ~/.local/bin && npm config set prefix ~/.local'
# Prepend (not append) so non-interactive ssh commands see the tools too;
# Ubuntu's .bashrc returns early for non-interactive shells.
grep -qxF 'export PATH="$HOME/.local/bin:$PATH"' "$AGENT_HOME/.bashrc" ||
  as_agent "sed -i '1i export PATH=\"\$HOME/.local/bin:\$PATH\"' ~/.bashrc"

# Generated from the user's tool selection (see tools.ts).
# shellcheck source=/dev/null
. /usr/local/lib/agent-vm/install-tools.sh

rm -f "$STATE_DIR/phase"
date -u +%FT%TZ > "$STATE_DIR/ready"
log "setup complete"
