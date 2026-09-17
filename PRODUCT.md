# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Inferred from the product documentation: solo developers running AI coding agents on a VPS and checking on them from a laptop or phone.

## Product Purpose

Kohlab is a self-hosted command center for persistent AI coding agents. It keeps agents running through disconnects, isolates concurrent workspaces, exposes live terminals, and gives the developer a review-before-merge workflow.

## Positioning

Its distinct mechanism is persistent agent sessions plus isolated workspaces with a live review and commit loop, operated from any browser without a separate database or desktop app.

## Operating Context

The user creates or clones a repository workspace, launches an agent, watches its terminal remotely, returns after disconnection, reviews diffs and logs, and commits or discards the result. A small team and shared read-only links are supported by the shipped product.

## Capabilities and Constraints

- Persistent PTY-backed agent sessions survive browser and SSH disconnects.
- Workspaces are isolated and can run in parallel.
- The dashboard exposes running, needs-review, stopped, and committed states.
- Workspace detail includes terminal, files, diff, log, share, lifecycle actions, and commit review.
- The server supports named users, roles, audit history, agent installation/status, GitHub repository browsing, image paste/upload, and read-only share links.
- The frontend is an existing React/Vite web app served by Bun; preserve its API contracts and accessible native browser affordances.

## Brand Commitments

- Product name: Kohlab.
- User-requested direction: complete frontend overhaul with a clean, Linear-like level of clarity and discipline, but a distinct Kohlab brand.
- Keep the product calm, precise, developer-native, and operational rather than marketing-led.

## Evidence on Hand

- Product and feature documentation in README.md and docs/.
- Existing React implementation in web/src/.
- Live terminal and workspace lifecycle are backed by the Bun server and PTY daemon.
- No customer, benchmark, pricing, or testimonial claims should be fabricated.

## Product Principles

1. Show what is happening now before explaining the system.
2. Make the review queue the center of gravity when agent work is ready.
3. Preserve work through disconnects without making persistence feel complex.
4. Keep destructive and irreversible actions explicit.
5. Prefer dense, legible operational surfaces over decorative chrome.

## Accessibility & Inclusion

Preserve keyboard focus, visible focus rings, semantic controls, readable contrast, responsive layouts for laptop and phone, and text labels for critical actions.
