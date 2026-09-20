# Install

Kohlab is a single Bun server. No database, no containers, no desktop app.

## Requirements

- **bun** — installed automatically if missing (`curl -fsSL https://bun.sh/install | bash`)
- **git**
- Linux for the service; the server itself runs anywhere bun does

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/nzkbuild/kohlab/main/install.sh | bash
```

It runs six steps:

| Step | What it does |
| --- | --- |
| dependencies | checks `git` and `bun`, installing bun if it is missing |
| checkout | clones `~/kohlab`, or fast-forwards an existing one |
| install | `bun install`, then builds the dashboard |
| command | writes `kohlab` to `/usr/local/bin` |
| service | writes and starts `kohlab.service`, generating an access key |
| verify | runs the command it just installed, then `kohlab doctor` |

From a checkout instead:

```bash
git clone https://github.com/nzkbuild/kohlab.git
cd kohlab
bash install.sh
```

### Options

| Option | Effect |
| --- | --- |
| `--key <secret>` | use this access key instead of generating one |
| `--no-systemd` | install and build, but create no service |
| `--no-command` | do not put `kohlab` on the PATH |
| `-h`, `--help` | the list above, plus the environment variables |

`KOHLAB_HOME` (checkout), `KOHLAB_REPO`, `KOHLAB_BIN_DIR`, `KOHLAB_UNIT_DIR` and
`KOHLAB_PORT` override the defaults. Setting `KOHLAB_UNIT_DIR` to anything other
than `/etc/systemd/system` writes the unit file without touching systemd — useful
for provisioning an image.

The server itself takes `PORT` (7676) and `HOST` (`0.0.0.0`). `HOST=127.0.0.1`
keeps it to this box; anywhere else, a server with no access key and no members
generates one rather than serving the world, and stores it at `$WORKS_DIR/key`.
`kohlab key` prints it.

Re-running the installer is safe: it updates the checkout, rewrites its own
command wrapper, and leaves an existing service, key and unit file untouched.

### Why `kohlab` is a wrapper, not a symlink

The entry point starts with `#!/usr/bin/env bun`, and bun lives in a directory
that only *interactive* shells put on `PATH`. A symlink to it therefore works
when you type `kohlab` and fails from cron, from a systemd unit, and from
`ssh host kohlab ls`. The installer writes a three-line `/bin/sh` wrapper with an
absolute interpreter path instead, so the command works from anywhere.

## Open it

Kohlab is designed to run on a server and be reached over SSH:

```bash
kohlab open                                   # every address this box answers on
ssh -L 7676:localhost:7676 user@your-server   # or tunnel it
# → open http://localhost:7676
```

## Access key

The installer generates one and writes it into the unit; the dashboard prompts
for it. To set your own:

```bash
bash install.sh --key "$(openssl rand -hex 24)"
```

> Never expose port 7676 to the public internet without a reverse proxy.
> See [reverse-proxy.md](reverse-proxy.md).

## Check it

```bash
kohlab status    # installed, running, up to date
kohlab doctor    # dependencies, service, KillMode, port, access key
```

`doctor` exits non-zero when something is actually wrong, so it is safe to use in
a provisioning script. It is deliberately picky about two things: a `KillMode`
other than `process`, which makes a restart kill every live agent session, and a
missing access key, which leaves the port open to anything that reaches it.

## Verify it works

```bash
kohlab create ~/my-project "describe the codebase" claude
kohlab list
kohlab logs <id>          # what the agent printed
```

## Updating

```bash
kohlab update             # or --check to see what it would do
```

See [upgrade.md](upgrade.md) — including over-the-air updates from the dashboard.
