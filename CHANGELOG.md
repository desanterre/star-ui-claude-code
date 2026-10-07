# Changelog

## 0.1.0

First release: the Star-Office-UI pixel office, as a VS Code extension for Claude Code.

- One character per agent: Claude's main conversation, Claude Code's built-in sub-agents (Explore, Plan, general-purpose) and your own sub-agents. Live activity from Claude Code hooks: tools, delegation, approvals, compaction, errors.
- Agents walk around walls and furniture to the room that matches what they do (office, lounge, server room, bedroom), with an animation for each state.
- Meetings: the main conversation and the sub-agents it started gather around its desk. The meeting thread shows the briefs sent to each sub-agent and their work; finished meetings move to *Past meetings*.
- Office chat: a character's conversation, read from Claude Code's transcript, with reasoning and tool calls.
- Messages from the office open Claude Code with the message ready to send, in a new or the current conversation.
- Stop buttons: Claude Code stops at its next step.
- Team briefing when a session or a sub-agent starts: its role, its teammates, the team and agent contexts, the linked folders. The team's folders become Claude Code working directories.
- *Create a Virtual Team of Agents*: Claude Code sub-agents from two presets (*Software team*, *Kubernetes & Go*).
- *Connect* adds hooks to Claude Code's `settings.json`; *Disconnect* removes them. The hook runs with VS Code's own runtime.
- Activity log, team list, status bar item, demo mode, English and French, "office" and "lodge" rooms. The office fits its panel; panels become tabs in narrow views.
