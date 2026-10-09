# Changelog

## 0.1.0

First release.

- Your messages on a panel behind a bar in the mode's colour; Claude's replies indented without the bullet.
- One-line tool rows (`→ Read`, `← Edit`, `$ command`, `✱ Grep`), every call on its own row.
- Shell output and errors on the row for grouped calls; standalone calls keep Claude Code's result block, which ctrl+o expands.
- `▣ Built · model · time` at the end of each reply, `Planned` in plan mode.
- Plain spinner words: Thinking, Writing, Running, Preparing.
- A session sidebar: title, account and plan usage, model with effort and ultracode, context and cost, MCP servers, todos, modified files. Long lists fold into a `+N more` that expands on a click.
- `/sidebar` to show or hide it; nine settings in `/config`.
