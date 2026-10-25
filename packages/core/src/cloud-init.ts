// First-boot script for agent VMs. Installs the base toolchain and agent CLIs
// for the default `ubuntu` user. Swap for a pre-baked image once boot time matters.

export interface CloudInitOptions {
  sshPublicKey: string;
}

export const VM_USER = "ubuntu";

export function buildCloudInit({ sshPublicKey }: CloudInitOptions): string {
  return `#cloud-config
ssh_authorized_keys:
  - ${sshPublicKey.trim()}

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
