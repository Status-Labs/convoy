# Reaching VMs from your phone (Tailscale)

[Tailscale](https://tailscale.com) puts a VM on your own private network (a *tailnet*) along with your phone and laptop. Your phone can then reach the VM from anywhere, by name, without any port opened to the internet: the VM's firewall still lets only SSH in from outside.

## Set up once

1. Create a free Tailscale account and install the Tailscale app on your phone (and laptop, if you like). Sign in to the same account on each.
2. Install an SSH app on your phone: Termius or Blink Shell on iOS, Termius or Termux on Android.
3. Optional, for launches with no sign-in step: create an auth key at [login.tailscale.com/admin/settings/keys](https://login.tailscale.com/admin/settings/keys) and put it in `.env`:

   ```sh
   TAILSCALE_AUTH_KEY=tskey-auth-...
   ```

   Make it **reusable** so it works for many VMs, and **not ephemeral**: Tailscale removes ephemeral devices soon after they go offline, which would drop VMs that are asleep. If your tailnet requires device approval, also tick **pre-approved**.

## Launch a VM on your tailnet

In the TUI, tick **Tailscale** at the tools step (below the agent tools). On the command line:

```sh
pnpm cli create --tailscale
```

- **With `TAILSCALE_AUTH_KEY`**, the VM joins your tailnet as soon as setup finishes, named after the VM.
- **Without it**, press `l` on the VM (or `pnpm cli login <vm>`) and open the Tailscale link it shows to add the VM to your tailnet.

To add a VM that already exists: `pnpm cli tailscale <vm>`. It installs Tailscale if needed.

## Connect from your phone

With the Tailscale app connected, open your SSH app and connect to:

```
agent@agent-vm-1a2b3c
```

That's the VM's name, which works if MagicDNS is on (the default for new tailnets; otherwise use the VM's `100.x.y.z` address from the Tailscale app). No private key is needed: VMs use [Tailscale SSH](https://tailscale.com/kb/1193/tailscale-ssh), which signs you in with your Tailscale identity. By default Tailscale asks you to confirm in the browser every 12 hours.

Start or resume a `tmux` session so agents keep running when your phone sleeps or drops the connection:

```sh
tmux new -A -s main
```

Then start an agent (`claude`, `codex`, ...) inside it. Next time, the same command takes you back to the same screen, from your phone or your laptop.

## See a web app on your phone

Every port on the VM is reachable from your tailnet (and only from it). Start a dev server listening on all interfaces, then open `http://agent-vm-1a2b3c:3000` in your phone's browser:

```sh
npm run dev -- --host 0.0.0.0     # Vite
next dev -H 0.0.0.0               # Next.js
```

Servers that listen on `localhost` only aren't reachable this way; that's the usual default, so most need the flag above. Docker containers publish to localhost on agent VMs, so they aren't reachable either unless you publish them on all interfaces (`-p 0.0.0.0:3000:3000`), which also needs `agent-vm-firewall expose` (see [port-forwarding.md](port-forwarding.md)).

## How it's set up and what to know

- Setup installs Tailscale from Tailscale's own package repository and adds one firewall rule: allow everything arriving on the `tailscale0` interface. Traffic from the internet is unaffected.
- The auth key is sent over SSH after setup, written to a root-only temporary file, used to join, and deleted. It's never in the cloud provider's VM setup data and isn't kept on the VM.
- **Anyone on your tailnet can reach every port on the VM.** If you share your tailnet with other people, limit them with [Tailscale access controls](https://tailscale.com/kb/1018/acls).
- Tailscale SSH bypasses the VM's own SSH settings (key-only, `agent` only): who may connect, and as which user, is set by your tailnet's access controls. The default lets you, and only you, sign in to your own devices, as any user including root. The `agent` user has passwordless sudo anyway.
- **Sleep and wake** keep the VM on your tailnet with the same name: its Tailscale identity is on the disk, so a woken VM reconnects by itself, even though its public IP changes.
- **Deleting** a running VM signs it out of Tailscale first, so its identity can't be used again. Remove leftover entries, and VMs deleted while asleep, from the [machines page](https://login.tailscale.com/admin/machines).
