#!/bin/bash
# Prints what Convoy's setup controls on a machine, so CI can check that a
# second run of the update changes nothing. Run as root.
set -euo pipefail
sha256sum \
  /etc/ssh/sshd_config.d/00-convoy.conf /etc/fail2ban/jail.d/convoy.local \
  /etc/apt/apt.conf.d/20auto-upgrades /etc/sysctl.d/99-convoy.conf \
  /etc/apparmor.d/convoy-chrome /usr/local/sbin/convoy-firewall \
  /etc/ufw/after.rules /etc/ufw/user.rules /etc/ufw/user6.rules \
  /etc/convoy/version /etc/convoy/migration /etc/convoy/tools \
  /home/agent/.bashrc /home/agent/.npmrc
ufw status verbose
# Rule counters change between runs; the rules shouldn't.
iptables-save | grep -v '^#' | sed -E 's/\[[0-9]+:[0-9]+\]//'
systemctl is-enabled fail2ban unattended-upgrades
sysctl net.ipv4.conf.all.accept_redirects kernel.kptr_restrict
