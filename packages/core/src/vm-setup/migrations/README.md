# VM migrations

One-off steps for existing VMs that `converge.sh` can't express by re-running,
such as removing a file or renaming a folder. Name them `NNNN-what-it-does.sh`
(`0001-remove-old-firewall-rule.sh`). They run as root, in order, once per VM,
before `converge.sh` brings the rest up to date. New VMs skip the ones that
existed when they were set up.

Make each one safe on a VM where there's nothing to change, and bump
`SETUP_VERSION` in `../vm-updates.ts` in the same change.
