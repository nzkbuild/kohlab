# Contributing

Kohlab is self-hosted software that runs coding agents on your own machine. The bar
for a change is that it can be checked.

## Getting set up

```bash
git clone https://github.com/nzkbuild/kohlab.git
cd kohlab
bun install
(cd web && bun install && bun run build)
bun run cli.ts server       # http://localhost:7676
```

`bun run check` runs everything: the unit checks, the HTTP contract against a real
throwaway server, the isolation checks, and both typechecks. It starts its own
server on its own port, socket and state directory, so it will not disturb an
instance you have running. Add `--verbose` to see each check's output.

Two checks need root, because they create and remove real OS accounts; they skip
themselves with a printed reason when they cannot provision.

## Before you open a pull request

- **`bun run check` passes.** Not "mostly" — the suite is the argument that the
  change is safe.
- **A new claim needs a check.** This repository's convention is that nothing is
  stated as working without something runnable behind it. If you fix a bug, the
  check that would have caught it belongs in the same commit.
- **Both typechecks are clean**, backend and frontend.
- **The changelog has a line**, under `## [Unreleased]`.

## Conventions

- **Commit messages say why.** The diff already says what.
- **Comments explain the non-obvious decision**, especially where the code looks
  wrong until you know the reason. If you find yourself writing what the next line
  does, delete it.
- **No new dependency for something the standard library does.** Bun and Node ship
  a lot; `node:fs`, `node:crypto`, `fetch` and `Intl` cover most of what this
  project needs.
- **Frontend:** Tailwind with the tokens in `web/src/styles.css`, no hard-coded
  colours — `scripts/check-contrast.mjs` fails the build otherwise. Primitives come
  from `web/src/components/ui.tsx`; use them rather than new markup.
- **Accessibility is not a follow-up.** Keyboard reachable, labelled controls, and a
  live-region announcement for state changes. `docs/frontend-contract.md`.
- **Security-relevant changes:** read `SECURITY.md` first. Anything touching the
  route table, authentication, or spawning belongs behind a check.

## Documentation

`docs/` is part of the product. If you change behaviour an operator can see, the doc
that describes it changes in the same commit — `docs/architecture.md` for the shape,
`docs/upgrade.md` for updates, `docs/isolation.md` for the trust boundary.

## Reporting a bug

Include the version (`kohlab --version`), what you did, and what happened. For
anything that looks exploitable, use `SECURITY.md` instead of the issue tracker.

## Licence

Contributions are accepted under the MIT licence in `LICENSE`.
