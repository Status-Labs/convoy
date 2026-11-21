# Backups

Work an agent has pushed to GitHub is already safe. Backups cover the rest: unpushed branches, files outside git, sign-ins and settings.

## DigitalOcean

```sh
DO_BACKUPS=daily    # or weekly, or leave empty for off
```

New VMs, and VMs woken from sleep, get [DigitalOcean's automatic backups](https://docs.digitalocean.com/products/backups/):

| Plan | When (UTC) | Kept | Price |
| --- | --- | --- | --- |
| `daily` | every day, 08:00–12:00 | 7 days | +30% of the droplet's price |
| `weekly` | Sundays, 08:00–12:00 | 4 weeks | +20% |

Nothing runs on the VM and no storage credentials go on it. Restore a whole VM from the DigitalOcean control panel (Backups tab on the droplet).

- **Backups are deleted with the droplet.** That includes sleep, which deletes the droplet but keeps a snapshot of its disk; waking turns backups on again for the new droplet.
- VMs launched before you set `DO_BACKUPS` don't change. Turn backups on for them in the control panel.
- Convoy's cost estimates don't include backups.
- Other providers: not yet. Use snapshots (`b` in the TUI) before risky work.
