// First-boot script for agent VMs, shared by every provider. Creates an
// `agent` user with the given SSH key and installs the base toolchain and
// agent CLIs. Swap for a pre-baked image once boot time matters.

export interface CloudInitOptions {
  sshPublicKey: string;
}

// Our own user rather than the image default, which differs per provider
// (ubuntu on OVH, root on DigitalOcean).
export const VM_USER = "agent";

export function buildCloudInit({ sshPublicKey }: CloudInitOptions): string {
  return `#cloud-config
users:
  - name: ${VM_USER}
    groups: [sudo]
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    ssh_authorized_keys:
      - ${sshPublicKey.trim()}

disable_root: true
ssh_pwauth: false

package_update: true
packages:
  - git
  - curl
  - build-essential
  - python3
  - python3-pip
  - python3-venv
  - ripgrep
  - jq
  - tmux

runcmd:
  - curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  - apt-get install -y nodejs
  - npm install -g @anthropic-ai/claude-code @openai/codex
  - mkdir -p /var/lib/agent-vm && date -u +%FT%TZ > /var/lib/agent-vm/ready
`;
}
