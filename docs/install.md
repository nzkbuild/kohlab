# Install

Kohlab is a single Bun server. No database, no containers.

## Requirements

- **bun** (`curl -fsSL https://bun.sh/install | bash`)
- **git**

## Quick start

```bash
git clone https://github.com/nzkbuild/kohlab.git
cd kohlab
bun run cli.ts server
```

The dashboard is now on `http://localhost:7676`.

## Open it from your laptop / phone

Kohlab is designed to run on a server and be reached over SSH:

```bash
ssh -L 7676:localhost:7676 user@your-server
# → open http://localhost:7676 in your browser
```

## Access key (optional, recommended)

By default the server has **no access key** — it's open to anything that can
reach the port. Set `KOHLAB_KEY` to require a key:

```bash
KOHLAB_KEY=your-long-random-secret bun run cli.ts server
```

The dashboard then prompts for it; enter the same value.

> Never expose port 7676 to the public internet without a reverse proxy.
> See [reverse-proxy.md](reverse-proxy.md).

## Verifying it works

```bash
bun run cli.ts new ~/my-project "describe the codebase" claude
bun run cli.ts start <id>
bun run cli.ts ls
```
