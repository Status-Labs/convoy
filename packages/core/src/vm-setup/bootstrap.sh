#!/bin/bash
# Runs once as root at first boot (from cloud-init runcmd), after packages are
# upgraded and the config files from write_files are in place. Applies the
# security baseline, then installs the agent tools the user picked.
set -euo pipefail

AGENT_USER=agent
AGENT_HOME=/home/$AGENT_USER
log() { echo "[agent-vm] $*"; }

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
sshd -t
systemctl restart ssh

log "applying kernel network hardening"
sysctl --system >/dev/null

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

log "installing Node.js"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

log "preparing $AGENT_USER's environment"
as_agent 'mkdir -p ~/.local/bin && npm config set prefix ~/.local'
# Prepend (not append) so non-interactive ssh commands see the tools too;
# Ubuntu's .bashrc returns early for non-interactive shells.
as_agent "sed -i '1i export PATH=\"\$HOME/.local/bin:\$PATH\"' ~/.bashrc"

# Generated from the user's tool selection (see tools.ts).
# shellcheck source=/dev/null
. /usr/local/lib/agent-vm/install-tools.sh

mkdir -p /var/lib/agent-vm
date -u +%FT%TZ > /var/lib/agent-vm/ready
log "setup complete"
