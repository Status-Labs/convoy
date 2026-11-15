// GitLab's CLI. GitLab has no official apt repo, so this installs the latest
// release's .deb after checking it against the release's checksums.

/** Root commands that install GitLab's CLI (`glab`) from its latest release. */
export const GLAB_INSTALL = [
  "tag=$(curl -fsSL https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest | jq -r .tag_name)",
  'deb="glab_${tag#v}_linux_$(dpkg --print-architecture).deb"',
  'dir=$(mktemp -d)',
  'curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/$tag/downloads/$deb" -o "$dir/$deb"',
  'curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/$tag/downloads/checksums.txt" -o "$dir/checksums.txt"',
  '(cd "$dir" && grep " $deb\\$" checksums.txt | sha256sum -c -)',
  'apt-get install -y -q "$dir/$deb"',
  'rm -rf "$dir"',
].join("\n");
