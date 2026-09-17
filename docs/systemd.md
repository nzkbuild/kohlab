# Auto-start on reboot (systemd)

Run the Kohlab server as a systemd service so it comes back after a reboot.

## 1. Create the unit

`/etc/systemd/system/kohlab.service`:

```ini
[Unit]
Description=Kohlab agent workspace server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/kohlab
Environment=KOHLAB_KEY=your-long-random-secret
ExecStart=/root/.bun/bin/bun run server.ts
Restart=on-failure
RestartSec=3
# The PTY daemon is deliberately spawned detached so it outlives the server and
# keeps every agent session and its scrollback alive across a restart. systemd's
# default KillMode=control-group signals the whole unit cgroup, which would kill
# that daemon too and take every live agent with it — the opposite of the
# product's promise. Signal only the server process.
KillMode=process

[Install]
WantedBy=multi-user.target
```

Adjust `User`, `WorkingDirectory`, and the `bun` path (`which bun`) to your setup.

## 2. Enable + start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kohlab
```

## 3. Check it

```bash
systemctl status kohlab
journalctl -u kohlab -f
```

## Notes

- The PTY daemon (`pty-daemon.cjs`) is spawned on demand by the server; no
  separate unit is needed. It is detached on purpose: a server restart adopts
  the running daemon (see `ptyConnect` in `lib.ts`) so live agent sessions
  survive. `KillMode=process` above is what makes that true under systemd.
- Restarting the **daemon** itself still terminates every live agent session,
  because the PTYs are its children. Restart the server freely; restart the
  daemon only when you accept losing running agents.
- If several Kohlab servers run on one box, give each its own `PTY_SOCKET`,
  `PORT`, and `WORKS_DIR`. They otherwise share `/tmp/kohlab-pty.sock` and will
  fight over the same daemon.
- Workspace state lives in `.works/` inside `WorkingDirectory`. Back it up if
  your workspaces matter (see [upgrade.md](upgrade.md)).
