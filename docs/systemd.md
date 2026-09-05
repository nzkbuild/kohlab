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
  separate unit is needed.
- Workspace state lives in `.works/` inside `WorkingDirectory`. Back it up if
  your workspaces matter (see [upgrade.md](upgrade.md)).
