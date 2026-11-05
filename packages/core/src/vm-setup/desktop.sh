#!/bin/bash
# Installs a Linux desktop (XFCE) with a browser-based viewer (KasmVNC) and
# Firefox. Runs as root, from first-boot setup or over SSH for an existing VM.
# The viewer listens on localhost only: reach it through an SSH tunnel or
# `tailscale serve`, never an open port.
set -euo pipefail

AGENT_USER=agent
AGENT_HOME=/home/$AGENT_USER
PORT=8444
DISPLAY_NUM=1

# Pinned; bump the version and checksums together (GitHub release digests).
KASMVNC_VERSION=1.5.2
declare -A KASMVNC_SHA256=(
  [noble_amd64]=89a5d1fbe9e032b122202be158a2b25f15c97e0a5b8dcf92a5e6835c7b7b2acd
  [noble_arm64]=4d680f3d1eb77fb155ae67af7f9fa25d7fbd38a7f69ae146784c7f738e2eed1a
  [jammy_amd64]=a7fb93f4ce3cfc93a3ddd593c23a437d8929791a79e1598ff2901cc7020b3e8f
  [jammy_arm64]=c537cc8be5bb316fdb9144c8296cdc1e111ca735064e66bb208d986dd61e64f6
)

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1

as_agent() {
  runuser -u "$AGENT_USER" -- env HOME="$AGENT_HOME" USER="$AGENT_USER" bash -c 'cd ~ && '"$1"
}

echo "[agent-vm] installing desktop (XFCE)"
apt-get update -q
apt-get install -y -q --no-install-recommends \
  xfce4 xfce4-terminal xfce4-notifyd dbus-x11 at-spi2-core \
  fonts-dejavu fonts-noto-color-emoji xdg-utils

# Ubuntu's firefox package installs the snap; Mozilla's apt repo has the deb.
echo "[agent-vm] installing Firefox"
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://packages.mozilla.org/apt/repo-signing-key.gpg -o /etc/apt/keyrings/packages.mozilla.org.asc
echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main" \
  > /etc/apt/sources.list.d/mozilla.list
printf 'Package: *\nPin: origin packages.mozilla.org\nPin-Priority: 1000\n' > /etc/apt/preferences.d/mozilla
apt-get update -q
apt-get install -y -q firefox
# No first-run pages or default-browser prompts on a VM.
install -d -m 0755 /etc/firefox/policies
cat > /etc/firefox/policies/policies.json <<'EOF'
{
  "policies": {
    "DontCheckDefaultBrowser": true,
    "OverrideFirstRunPage": "",
    "OverridePostUpdatePage": "",
    "SkipTermsOfUse": true
  }
}
EOF

echo "[agent-vm] installing KasmVNC $KASMVNC_VERSION"
codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
arch=$(dpkg --print-architecture)
sha=${KASMVNC_SHA256[${codename}_${arch}]:-}
if [ -z "$sha" ]; then
  echo "[agent-vm] no KasmVNC package for ubuntu $codename/$arch" >&2
  exit 1
fi
deb=$(mktemp --suffix=.deb)
curl -fsSL -o "$deb" \
  "https://github.com/kasmtech/KasmVNC/releases/download/v$KASMVNC_VERSION/kasmvncserver_ubuntu_${codename}_${KASMVNC_VERSION}_${arch}.deb"
echo "$sha  $deb" | sha256sum -c --quiet -
chmod 644 "$deb"
apt-get install -y -q "$deb"
rm -f "$deb"

echo "[agent-vm] configuring the desktop"
# KasmVNC checks its default certificate at startup, even with SSL off.
usermod -aG ssl-cert "$AGENT_USER"
as_agent "mkdir -p ~/.vnc ~/.config/agent-vm && chmod 700 ~/.config/agent-vm"
cat > "$AGENT_HOME/.vnc/kasmvnc.yaml" <<EOF
# agent-vm: localhost only, plain HTTP. Reached through an SSH tunnel or
# tailscale serve (HTTPS), so traffic never leaves the VM unencrypted.
desktop:
  resolution:
    width: 1280
    height: 720
  allow_resize: true
network:
  protocol: http
  interface: 127.0.0.1
  websocket_port: $PORT
  use_ipv6: false
  ssl:
    require_ssl: false
user_session:
  idle_timeout: never
EOF
cat > "$AGENT_HOME/.vnc/xstartup" <<'EOF'
#!/bin/sh
unset SESSION_MANAGER DBUS_SESSION_BUS_ADDRESS
exec dbus-launch --exit-with-session startxfce4
EOF
chmod 755 "$AGENT_HOME/.vnc/xstartup"
touch "$AGENT_HOME/.vnc/.de-was-selected"

# One password per VM, made here so it never travels in cloud-init user data.
password_file=$AGENT_HOME/.config/agent-vm/desktop-password
if [ ! -s "$password_file" ]; then
  (umask 077 && openssl rand -base64 24 | tr -d '/+=\n' | cut -c1-20 > "$password_file")
fi
chown -R "$AGENT_USER:$AGENT_USER" "$AGENT_HOME/.vnc" "$AGENT_HOME/.config/agent-vm"
as_agent 'pw=$(cat ~/.config/agent-vm/desktop-password) && printf "%s\n%s\n" "$pw" "$pw" | kasmvncpasswd -u agent -w ~/.kasmpasswd >/dev/null && chmod 600 ~/.kasmpasswd'

cat > /etc/systemd/system/agent-vm-desktop.service <<EOF
[Unit]
Description=agent-vm desktop (KasmVNC on 127.0.0.1:$PORT)
After=network.target

[Service]
User=$AGENT_USER
WorkingDirectory=$AGENT_HOME
ExecStartPre=-/usr/bin/vncserver -kill :$DISPLAY_NUM
ExecStart=/usr/bin/vncserver :$DISPLAY_NUM -fg -autokill
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now agent-vm-desktop.service
echo "[agent-vm] desktop ready on 127.0.0.1:$PORT"
