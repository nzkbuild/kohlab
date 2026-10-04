# Routing (apply the skill without being asked)

The user writes vague prompts. Map intent to a skill yourself; do not wait for a slash command.

| User says something like | Use |
|---|---|
| broken, not working, error, slow, "why does..." | `mattpocock-skills:diagnosing-bugs` |
| add / build / implement a feature | `ponytail:ponytail`, then `mattpocock-skills:tdd` if logic is non-trivial |
| ugly, looks off, redesign, polish, UI, mobile layout | `impeccable:impeccable` (read `DESIGN.md` and `PRODUCT.md` first) |
| "is this good", review, before release | `code-review` (+ `security-review` if auth, push, pty, or server routes changed) |
| "how does X work", docs/API question | `mattpocock-skills:research` or context7 |
| unsure what the user wants | `mattpocock-skills:grilling`, a few questions max |

Any code task also follows `ponytail:ponytail`.

# Releases

Commits are `release vX.Y.Z: ...`; update `CHANGELOG.md` with each one.
