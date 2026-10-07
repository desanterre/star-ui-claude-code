import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { after, before, describe, it } from "node:test"
import { briefing, hasBriefing } from "../src/briefing"
import { Bridge } from "../src/bridge"
import {
  HOOK_EVENTS,
  hookCommand,
  hookEntries,
  hookEvents,
  hooksCurrent,
  hooksInstalled,
  installHooks,
  readAgents,
  readTranscript,
  roster,
  subagentTranscript,
  syncAdditionalDirectories,
  uninstallHooks,
} from "../src/claude"
import { OfficeModel } from "../src/office"
import type { ConnectionInfo, HookInput, HookPayload, HookReply } from "../src/protocol"

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))
const CONN: ConnectionInfo = { hooksInstalled: true, claudeDetected: true, live: true, canPrompt: true, demo: false }

describe("hooks in settings.json", () => {
  const entries = hookEntries(hookCommand("/Applications/Visual Studio Code.app/Code Helper (Plugin)", "/Users/me/.star-ui-claude-code/star-ui-claude-code-hook.cjs", "darwin"))

  it("runs the hook with VS Code's own runtime, quoted for the shell", () => {
    assert.deepEqual(hookCommand("/opt/My App/node", "/h/it's/star-ui-claude-code-hook.cjs", "linux"), {
      command: "ELECTRON_RUN_AS_NODE=1 '/opt/My App/node' '/h/it'\\''s/star-ui-claude-code-hook.cjs'",
    })
    assert.deepEqual(hookCommand("C:\\Program Files\\Code\\Code.exe", "C:\\Users\\me\\star-ui-claude-code-hook.cjs", "win32"), {
      command: "$env:ELECTRON_RUN_AS_NODE='1'; & 'C:\\Program Files\\Code\\Code.exe' 'C:\\Users\\me\\star-ui-claude-code-hook.cjs'",
      shell: "powershell",
    })
  })

  it("waits only for the events that can stop a session or add context", () => {
    assert.deepEqual(Object.keys(entries), [...HOOK_EVENTS])
    assert.equal(entries.PreToolUse[0].hooks[0].async, undefined)
    assert.equal(entries.SessionStart[0].hooks[0].async, undefined)
    assert.equal(entries.PostToolUse[0].hooks[0].async, true)
    assert.equal(entries.Notification[0].hooks[0].async, true)
  })

  it("adds its hooks next to the user's settings and hooks, and removes only its own", () => {
    const file = path.join(tmp("star-settings-"), "settings.json")
    const mine = { matcher: "Bash", hooks: [{ type: "command", command: "~/bin/check.sh" }] }
    fs.writeFileSync(file, JSON.stringify({ model: "opus", hooks: { PreToolUse: [mine] }, permissions: { allow: ["Bash(ls)"] } }))
    assert.equal(hooksInstalled(file), false)

    assert.deepEqual(installHooks(file, entries), { changed: true })
    const data = JSON.parse(fs.readFileSync(file, "utf8"))
    assert.equal(data.model, "opus")
    assert.deepEqual(data.permissions, { allow: ["Bash(ls)"] })
    assert.deepEqual(data.hooks.PreToolUse[0], mine)
    assert.equal(data.hooks.PreToolUse.length, 2)
    assert.ok(hooksInstalled(file))
    assert.ok(hooksCurrent(file, entries))
    assert.deepEqual(installHooks(file, entries), { changed: false }, "installing twice changes nothing")

    // A new VS Code path replaces the old entries instead of adding more.
    const moved = hookEntries(hookCommand("/new/runtime", "/Users/me/.star-ui-claude-code/star-ui-claude-code-hook.cjs", "darwin"))
    assert.equal(hooksCurrent(file, moved), false)
    installHooks(file, moved)
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).hooks.PreToolUse.length, 2)

    assert.equal(uninstallHooks(file), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { model: "opus", hooks: { PreToolUse: [mine] }, permissions: { allow: ["Bash(ls)"] } })
    assert.equal(uninstallHooks(file), false)
  })

  it("creates settings.json when missing, and never overwrites a file it cannot read", () => {
    const dir = tmp("star-settings-")
    const file = path.join(dir, "settings.json")
    installHooks(file, entries)
    assert.ok(hooksInstalled(file))
    fs.writeFileSync(file, "{ not json")
    assert.throws(() => installHooks(file, entries), /not valid JSON/)
    assert.equal(fs.readFileSync(file, "utf8"), "{ not json")
  })

  it("keeps the folders added by hand in additionalDirectories", () => {
    const file = path.join(tmp("star-settings-"), "settings.json")
    fs.writeFileSync(file, JSON.stringify({ permissions: { additionalDirectories: ["/by/hand"], deny: ["Read(./.env)"] } }))
    assert.equal(syncAdditionalDirectories(file, ["/repo/a"], []), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).permissions, { additionalDirectories: ["/by/hand", "/repo/a"], deny: ["Read(./.env)"] })
    syncAdditionalDirectories(file, ["/repo/b"], ["/repo/a"])
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).permissions.additionalDirectories, ["/by/hand", "/repo/b"])
    assert.equal(syncAdditionalDirectories(file, ["/repo/b"], ["/repo/b"]), false)
  })
})

describe("agents", () => {
  it("reads custom sub-agents, the project's winning over the user's", () => {
    const user = tmp("star-agents-")
    const project = tmp("star-agents-")
    fs.writeFileSync(path.join(user, "reviewer.md"), "---\nname: reviewer\ndescription: Reviews code\ncolor: orange\n---\nYou review.")
    fs.writeFileSync(path.join(user, "helper.md"), "---\ndescription: \"Helps\"\n---\nHi")
    fs.writeFileSync(path.join(project, "reviewer.md"), "---\nname: reviewer\ndescription: Project reviewer\n---\nYou review.")
    fs.writeFileSync(path.join(project, "notes.txt"), "ignored")
    const agents = readAgents([user, project])
    assert.deepEqual(
      agents.map((a) => [a.name, a.description, a.color]),
      [
        ["helper", "Helps", undefined],
        ["reviewer", "Project reviewer", undefined],
      ],
    )
  })

  it("lists Claude's built-in agents first", () => {
    const config = tmp("star-config-")
    fs.mkdirSync(path.join(config, "agents"))
    fs.writeFileSync(path.join(config, "agents", "go-developer.md"), "---\nname: go-developer\ndescription: Writes Go\ncolor: cyan\n---\n")
    const list = roster(config, [])
    assert.deepEqual(
      list.map((a) => a.name),
      ["claude", "general-purpose", "Explore", "Plan", "go-developer"],
    )
    assert.equal(list.at(-1)?.color, "#06b6d4")
  })
})

describe("hook events in the office", () => {
  const base = { session_id: "S", cwd: "/work/app", transcript_path: "/t/S.jsonl" }
  const run = (inputs: Partial<HookInput>[]) => {
    const m = new OfficeModel()
    m.apply({ t: "roster", agents: roster(tmp("star-config-"), []) }, 0)
    inputs.forEach((input, i) => {
      for (const ev of hookEvents({ ...base, ...input } as HookInput)) m.apply(ev, 1000 + i)
    })
    return m
  }

  it("shows Claude working, its sub-agents in a meeting, and their tools", () => {
    const m = run([
      { hook_event_name: "SessionStart", source: "startup" },
      { hook_event_name: "UserPromptSubmit", prompt: "Add OAuth login" },
      { hook_event_name: "PreToolUse", tool_name: "Task", tool_use_id: "t1", tool_input: { subagent_type: "Explore", description: "Find the session store" } },
      { hook_event_name: "SubagentStart", agent_id: "A1", agent_type: "Explore" },
      { hook_event_name: "PreToolUse", agent_id: "A1", agent_type: "Explore", tool_name: "Grep", tool_use_id: "g1", tool_input: { pattern: "session" } },
    ])
    const snap = m.snapshot(CONN, 1010)
    assert.equal(snap.main?.name, "claude")
    assert.equal(snap.main?.busy, true)
    assert.equal(snap.main?.sessionTitle, "Add OAuth login")
    assert.equal(snap.main?.detail.hint, "Explore: Find the session store")
    const explore = snap.guests.find((c) => c.name === "Explore")!
    assert.equal(explore.busy, true)
    assert.equal(explore.state, "researching")
    assert.deepEqual(explore.detail, { kind: "tool", tool: "Grep", hint: "session" })
    assert.deepEqual(snap.meetings.map((x) => x.members), [["claude", "Explore"]])
  })

  it("raises and clears approval requests, and goes idle at the end of the turn", () => {
    const waiting = run([
      { hook_event_name: "UserPromptSubmit", prompt: "Deploy" },
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "kubectl apply -f x.yaml" } },
      { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_use_id: "b1" },
    ])
    assert.deepEqual(waiting.snapshot(CONN, 1010).main?.waiting, { kind: "permission", label: "Bash" })
    const done = run([
      { hook_event_name: "UserPromptSubmit", prompt: "Deploy" },
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b1" },
      { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_use_id: "b1" },
      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "b1" },
      { hook_event_name: "Stop" },
    ])
    const main = done.snapshot(CONN, 1010).main!
    assert.equal(main.waiting, undefined)
    assert.equal(main.busy, false)
  })
})

describe("transcripts", () => {
  const line = (o: object) => JSON.stringify(o)
  it("turns a Claude Code transcript into chat messages", () => {
    const file = path.join(tmp("star-transcript-"), "S.jsonl")
    fs.writeFileSync(
      file,
      [
        line({ type: "file-history-snapshot", snapshot: {} }),
        line({ type: "user", uuid: "u1", timestamp: "2026-10-07T10:00:00Z", message: { role: "user", content: "Add OAuth login" } }),
        line({ type: "user", uuid: "u2", isMeta: true, message: { role: "user", content: "<command-name>/clear</command-name>" } }),
        line({ type: "assistant", uuid: "a1", timestamp: "2026-10-07T10:00:05Z", message: { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: "Design first." }] } }),
        line({ type: "assistant", uuid: "a2", timestamp: "2026-10-07T10:00:06Z", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/w/auth.ts" } }] } }),
        line({ type: "user", uuid: "u3", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "secret file content" }] } }),
        line({ type: "assistant", uuid: "a3", timestamp: "2026-10-07T10:00:09Z", message: { id: "m2", role: "assistant", content: [{ type: "tool_use", id: "tu2", name: "Task", input: { subagent_type: "architect", description: "Design", prompt: "Design the OAuth flow." } }, { type: "text", text: "Briefing the architect." }] } }),
        "not json",
      ].join("\n"),
    )
    const messages = readTranscript(file)
    assert.deepEqual(
      messages.map((m) => [m.role, m.parts.map((p) => `${p.type}:${p.tool ?? ""}:${p.status ?? ""}:${p.title ?? p.text ?? ""}`)]),
      [
        ["user", ["text:::Add OAuth login"]],
        ["assistant", ["reasoning:::Design first.", "tool:Read:completed:auth.ts"]],
        ["assistant", ["subtask:architect:running:architect: Design", "text:::Briefing the architect."]],
      ],
    )
    assert.ok(!JSON.stringify(messages).includes("secret file content"), "tool results are not shown")
    assert.equal(messages[0].time, Date.parse("2026-10-07T10:00:00Z"))
  })

  it("finds a sub-agent's transcript next to its session", () => {
    const dir = tmp("star-transcript-")
    const main = path.join(dir, "S.jsonl")
    fs.mkdirSync(path.join(dir, "S", "subagents", "group"), { recursive: true })
    fs.writeFileSync(path.join(dir, "S", "subagents", "agent-A1.jsonl"), "")
    fs.writeFileSync(path.join(dir, "S", "subagents", "group", "agent-A2.jsonl"), "")
    assert.equal(subagentTranscript(main, "S", "A1"), path.join(dir, "S", "subagents", "agent-A1.jsonl"))
    assert.equal(subagentTranscript(main, "S", "A2"), path.join(dir, "S", "subagents", "group", "agent-A2.jsonl"))
    assert.equal(subagentTranscript(main, "S", "A3"), undefined)
  })
})

describe("briefing", () => {
  const empty = { context: "", folders: [], memory: [] }
  const agents = [
    { name: "claude", displayName: "Claude", mode: "primary" as const, builtIn: true },
    { name: "Explore", mode: "subagent" as const, builtIn: true, description: "Explores" },
    { name: "architect", mode: "subagent" as const, description: "Designs solutions" },
    { name: "go-developer", mode: "subagent" as const, description: "Writes Go" },
  ]

  it("tells the lead who is on the team and how to lead it", () => {
    const text = briefing({ agent: "claude", mainAgent: "claude", roster: agents, team: { ...empty, context: "We ship operators." }, own: empty })
    assert.match(text, /You are \*\*Claude\*\*, the lead of this session\./)
    assert.match(text, /- \*\*architect\*\*: Designs solutions/)
    assert.match(text, /- \*\*Explore\*\*: Explores/)
    assert.match(text, /## Leading the team/)
    assert.match(text, /## Team context\nWe ship operators\./)
  })

  it("tells a sub-agent its role and its teammates", () => {
    const repo = tmp("star-repo-")
    fs.writeFileSync(path.join(repo, "go.mod"), "module example.com/op\n\ngo 1.22\n")
    const text = briefing({ agent: "architect", mainAgent: "claude", roster: agents, team: empty, own: { ...empty, context: "Prefer small interfaces.", folders: [{ path: repo }] } })
    assert.match(text, /You are \*\*architect\*\*: Designs solutions/)
    assert.match(text, /- \*\*go-developer\*\*: Writes Go/)
    assert.ok(!text.includes("**architect**:", text.indexOf("## Your teammates")), "not listed among its own teammates")
    assert.match(text, /## Your context\nPrefer small interfaces\./)
    assert.match(text, /Go module example\.com\/op \(go 1\.22\)/)
  })

  it("stays silent when there is nothing to tell", () => {
    const builtInOnly = agents.filter((a) => a.mode === "primary" || ("builtIn" in a && a.builtIn))
    assert.equal(hasBriefing({ agent: "claude", mainAgent: "claude", roster: builtInOnly, team: empty, own: empty }), false)
    assert.equal(hasBriefing({ agent: "claude", mainAgent: "claude", roster: agents, team: empty, own: empty }), true)
  })
})

describe("hook script", () => {
  const home = tmp("star-hookhome-")
  const received: HookPayload[] = []
  let answer: HookReply | undefined
  const bridge = new Bridge(home, (p) => {
    received.push(p)
    return answer
  })
  const script = path.resolve("hook/star-hook.cjs")
  const runHook = (stdin: string, env: Record<string, string> = {}) =>
    new Promise<{ code: number | null; out: string; ms: number }>((resolve) => {
      const started = Date.now()
      const child = spawn(process.execPath, [script], { env: { ...process.env, STAR_UI_CLAUDE_HOME: home, ...env } })
      let out = ""
      child.stdout.on("data", (d) => (out += d))
      child.on("close", (code) => resolve({ code, out, ms: Date.now() - started }))
      child.stdin.end(stdin)
    })

  before(() => bridge.start())
  after(() => bridge.dispose())

  it("forwards a trimmed event, without file contents", async () => {
    const event = {
      hook_event_name: "PostToolUse",
      session_id: "S",
      cwd: "/w",
      tool_name: "Write",
      tool_use_id: "w1",
      tool_input: { file_path: "/w/secret.txt", content: "TOP SECRET" },
      tool_response: { content: "TOP SECRET" },
    }
    const { code, out } = await runHook(JSON.stringify(event))
    assert.equal(code, 0)
    assert.equal(out, "", "background events print nothing")
    const got = received.at(-1)!
    assert.equal(got.input.tool_input?.file_path, "/w/secret.txt")
    assert.ok(!JSON.stringify(got).includes("TOP SECRET"))
  })

  it("prints the office's answer for the events Claude Code waits for", async () => {
    answer = { continue: false, stopReason: "Stopped from the Star Office." }
    const { out } = await runHook(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "S", tool_name: "Bash" }))
    assert.deepEqual(JSON.parse(out), { continue: false, stopReason: "Stopped from the Star Office." })
    answer = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "You lead a team." } }
    const start = await runHook(JSON.stringify({ hook_event_name: "SessionStart", session_id: "S" }))
    assert.deepEqual(JSON.parse(start.out), { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "You lead a team." } })
    answer = undefined
  })

  it("never fails: bad input, or no office open", async () => {
    assert.deepEqual(await runHook("{ nope").then((r) => [r.code, r.out]), [0, ""])
    const alone = await runHook(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "S" }), { STAR_UI_CLAUDE_HOME: tmp("star-empty-") })
    assert.deepEqual([alone.code, alone.out], [0, ""])
    assert.ok(alone.ms < 2000)
  })
})
