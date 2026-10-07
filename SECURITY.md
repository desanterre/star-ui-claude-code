# Security policy

Please report vulnerabilities privately through GitHub: **Security › Report a vulnerability** on
<https://github.com/desanterre/star-ui-claude-code>. Do not open a public issue.

Scope worth knowing about:

- `hook/star-hook.cjs` runs inside Claude Code for every hook event. Its answer can stop a session or add context to it.
- `src/bridge.ts` is a local HTTP endpoint (127.0.0.1, random port, bearer token).
- *Connect* edits Claude Code's `settings.json` (hooks, and `permissions.additionalDirectories` for the team's linked folders).
