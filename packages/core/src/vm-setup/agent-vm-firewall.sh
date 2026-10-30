#!/bin/bash
# agent-vm-firewall: control which ports are reachable from the internet.
# Only SSH is open by default, and that includes ports published by Docker.
set -euo pipefail

STATE=/etc/agent-vm/exposed-ports
AFTER_RULES=/etc/ufw/after.rules
BEGIN_MARK="# BEGIN AGENT-VM DOCKER"
END_MARK="# END AGENT-VM DOCKER"

usage() {
  cat <<EOF
Usage: sudo agent-vm-firewall <command>

  status              show exposed ports and firewall rules
  expose <port>       open a TCP port to the whole internet (host and Docker)
  unexpose <port>     close it again
  apply-docker-rules  rewrite the Docker rules in $AFTER_RULES (used at setup)

Safer than exposing: forward the port over SSH from your machine
  agent-vm forward <vm> <port>
EOF
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "agent-vm-firewall: run with sudo" >&2
    exit 1
  fi
}

check_port() {
  if ! [[ "${1:-}" =~ ^[0-9]+$ ]] || [ "$1" -lt 1 ] || [ "$1" -gt 65535 ]; then
    echo "agent-vm-firewall: invalid port '${1:-}'" >&2
    exit 1
  fi
}

# Docker publishes ports by writing iptables rules directly, which bypasses
# ufw. These DOCKER-USER rules (evaluated before Docker's own) drop new
# inbound connections to containers unless the port was exposed here.
apply_docker_rules() {
  mkdir -p "$(dirname "$STATE")"
  touch "$STATE"
  local tmp
  tmp=$(mktemp)
  sed "/^$BEGIN_MARK\$/,/^$END_MARK\$/d" "$AFTER_RULES" > "$tmp"
  {
    echo "$BEGIN_MARK"
    echo "*filter"
    echo ":DOCKER-USER - [0:0]"
    echo "-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN"
    echo "-A DOCKER-USER -i docker0 -j RETURN"
    echo "-A DOCKER-USER -i br-+ -j RETURN"
    while read -r port; do
      if [ -n "$port" ]; then
        echo "-A DOCKER-USER -p tcp -m conntrack --ctorigdstport $port -j RETURN"
      fi
    done < "$STATE"
    echo "-A DOCKER-USER -m conntrack --ctstate NEW -j DROP"
    echo "-A DOCKER-USER -j RETURN"
    echo "COMMIT"
    echo "$END_MARK"
  } >> "$tmp"
  cat "$tmp" > "$AFTER_RULES"
  rm -f "$tmp"
}

expose() {
  require_root
  check_port "${1:-}"
  cat >&2 <<EOF
WARNING: port $1 is now reachable by anyone on the internet.
Anything listening on it (including Docker containers) can be found and
attacked by automated scanners within minutes. Make sure it requires
authentication, and run 'sudo agent-vm-firewall unexpose $1' when done.

Docker publishes to 127.0.0.1 by default on this VM. To expose a container,
also publish it on all interfaces: docker run -p 0.0.0.0:$1:<container-port> ...
EOF
  grep -qx "$1" "$STATE" 2>/dev/null || echo "$1" >> "$STATE"
  ufw allow "$1/tcp" comment 'agent-vm expose' >/dev/null
  apply_docker_rules
  ufw reload >/dev/null
  echo "Exposed port $1."
}

unexpose() {
  require_root
  check_port "${1:-}"
  sed -i "/^$1\$/d" "$STATE"
  ufw delete allow "$1/tcp" >/dev/null 2>&1 || true
  apply_docker_rules
  ufw reload >/dev/null
  echo "Closed port $1."
}

status() {
  require_root
  echo "Exposed ports:"
  if [ -s "$STATE" ]; then
    sed 's/^/  /' "$STATE"
  else
    echo "  none (only SSH is open)"
  fi
  echo
  ufw status verbose
}

case "${1:-}" in
  status) status ;;
  expose) expose "${2:-}" ;;
  unexpose) unexpose "${2:-}" ;;
  apply-docker-rules) require_root; apply_docker_rules ;;
  *) usage; exit 1 ;;
esac
