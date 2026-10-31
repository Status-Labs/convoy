# Reaching apps running on a VM

Agent VMs accept only SSH from the internet. To use a web app, API or dev server running on a VM, tunnel its port over SSH with `forward`. If other people need to reach it, open it to the internet with `expose`, which warns you first.

## Forward a port (recommended)

```sh
pnpm cli forward <vm> 3000          # VM port 3000 -> http://localhost:3000
pnpm cli forward <vm> 3000 8080     # VM port 3000 -> http://localhost:8080
```

`<vm>` is the VM's name or id, as shown by `pnpm cli list`.

Keep that terminal open while you use the app, and press Ctrl+C to close the tunnel. Nothing on the VM is opened to the internet: traffic goes through your existing SSH connection, and only you can reach the app.

Under the hood this is plain SSH local forwarding:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 3000:localhost:3000 agent@<vm-ip>
```

With plain `ssh` you can forward several ports at once, with one `-L` flag per port:

```sh
ssh -N -L 3000:localhost:3000 -L 5432:localhost:5432 agent@<vm-ip>
```

### Notes

- **The app can listen on `localhost` on the VM.** That's the safest setting, because only the tunnel can reach it.
- **Docker works as-is.** `docker run -p 3000:3000 ...` binds to `127.0.0.1` on these VMs by default (`/etc/docker/daemon.json`), which is what `forward` connects to.
- **"Address already in use":** something on your machine already uses that local port. Pick another one, such as `forward <vm> 3000 3001`.
- **The tunnel exits right away:** check that the VM is running and that SSH works (`pnpm cli ssh <vm>`).
- **The TUI has no port forwarding yet.** Use the CLI.

## Expose a port to the internet

Only expose a port when other people or services need to reach the app directly, and only for apps that require a login. Automated scanners find open ports within minutes.

```sh
pnpm cli expose <vm> 8080       # warns, then asks you to type the port number to confirm
pnpm cli firewall <vm>          # show exposed ports and firewall rules
pnpm cli unexpose <vm> 8080     # close it again
```

`expose` opens the port in `ufw` and in Docker's `DOCKER-USER` firewall chain. A Docker container is then reachable only if it publishes on all interfaces, for example `-p 0.0.0.0:8080:8080`, because the default binds to `127.0.0.1`.

On the VM itself, the same commands are:

```sh
sudo agent-vm-firewall status
sudo agent-vm-firewall expose 8080
sudo agent-vm-firewall unexpose 8080
```

Exposed ports stay open across reboots until you run `unexpose`.
