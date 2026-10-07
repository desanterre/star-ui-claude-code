// End-to-end check against the real Claude Code engine (the one the VS Code extension runs).
// It starts a real bridge, runs `claude -p` in a throwaway folder with Star UI's hooks passed through
// --settings (your own settings.json is not read or changed), and checks what reaches the office.
// Two short runs with the smallest model; they use your Claude Code login.
//
// usage: node scripts/e2e-claude.mjs            (finds the claude binary of the VS Code extension)
//        CLAUDE_BIN=/path/to/claude node scripts/e2e-claude.mjs
import * as esbuild from "esbuild"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { createRequire } from "node:module"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"

const require = createRequire(import.meta.url)
const failures = []
const check = (ok, label) => {
  console.log(`${ok ? "✔" : "✖"} ${label}`)
  if (!ok) failures.push(label)
}

function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN
  const dir = join(homedir(), ".vscode", "extensions")
  const ext = readdirSync(dir)
    .filter((n) => n.startsWith("anthropic.claude-code-"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .pop()
  const bin = ext && join(dir, ext, "resources", "native-binary", process.platform === "win32" ? "claude.exe" : "claude")
  if (!bin || !existsSync(bin)) throw new Error("Claude Code not found: install the VS Code extension or set CLAUDE_BIN")
  return bin
}

await esbuild.build({ entryPoints: ["src/bridge.ts", "src/claude.ts", "src/office.ts"], outdir: "out/e2e", bundle: true, platform: "node", format: "cjs", logLevel: "warning" })
const { Bridge } = require(resolve("out/e2e/bridge.js"))
const { hookCommand, hookEntries, hookEvents, readTranscript } = require(resolve("out/e2e/claude.js"))
const { OfficeModel } = require(resolve("out/e2e/office.js"))

const claude = findClaude()
const tmp = mkdtempSync(join(tmpdir(), "star-claude-e2e-"))
const home = join(tmp, "star")
const project = join(tmp, "project")
mkdirSync(project, { recursive: true })
writeFileSync(join(project, "hello.txt"), "The deployment window is Tuesday.\n")

let scenario = "briefing"
const inputs = []
const model = new OfficeModel()
const seen = new Set()
const bridge = new Bridge(home, ({ input }) => {
  inputs.push(input)
  if (input.transcript_path) seen.add(input.transcript_path)
  for (const ev of hookEvents(input)) model.apply(ev, Date.now())
  if (scenario === "briefing" && input.hook_event_name === "SessionStart") {
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "Team briefing: the team code is ZEBRA-4412." } }
  }
  if (scenario === "stop" && input.hook_event_name === "PreToolUse") return { continue: false, stopReason: "Stopped from the Star Office." }
  return undefined
})
await bridge.start()

// HOOK_RUNTIME: the runtime the extension writes in settings.json (VS Code's own executable).
const runtime = process.env.HOOK_RUNTIME || process.execPath
const settings = JSON.stringify({ hooks: hookEntries(hookCommand(runtime, resolve("hook/star-hook.cjs"))) })
function run(prompt) {
  return new Promise((done) => {
    const child = spawn(
      claude,
      ["-p", prompt, "--model", "haiku", "--settings", settings, "--setting-sources", "project,local", "--output-format", "json", "--max-turns", "8"],
      { cwd: project, env: { ...process.env, STAR_UI_CLAUDE_HOME: home }, stdio: ["ignore", "pipe", "pipe"] },
    )
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (err += d))
    child.on("close", (code) => {
      let result
      try {
        result = JSON.parse(out)
      } catch {}
      done({ code, result, out, err })
    })
  })
}

try {
  console.log(`claude: ${claude}\nhook runtime: ${runtime}`)
  // 1. Briefing at session start, a sub-agent, tools, end of turn.
  const first = await run("Tell me the team code written in your instructions. Then use the Explore sub-agent to find which file in this folder mentions a deployment window, and tell me the day.")
  const answer = String(first.result?.result ?? "")
  console.log(`answer: ${answer.slice(0, 160).replace(/\n/g, " ")}`)
  const names = inputs.map((i) => i.hook_event_name)
  check(names.includes("SessionStart") && names.includes("UserPromptSubmit") && names.includes("Stop"), `hooks reach the office (${[...new Set(names)].join(", ")})`)
  const delegation = inputs.find((i) => i.hook_event_name === "PreToolUse" && (i.tool_name === "Task" || i.tool_name === "Agent"))
  check(!!delegation && delegation.tool_input?.subagent_type === "Explore", "the delegation to Explore is seen, with its sub-agent type")
  const subStart = inputs.find((i) => i.hook_event_name === "SubagentStart")
  const subTool = inputs.find((i) => i.hook_event_name === "PreToolUse" && i.agent_id)
  check(!!subStart?.agent_id && subStart.agent_type === "Explore", "SubagentStart names the sub-agent")
  check(!!subTool && subTool.agent_id === subStart?.agent_id, "the sub-agent's tools are attributed to it")
  const subStop = inputs.find((i) => i.hook_event_name === "SubagentStop")
  check(!!subStop?.agent_transcript_path && existsSync(subStop.agent_transcript_path), "the sub-agent's transcript is on disk")
  const snap = model.snapshot({ hooksInstalled: true, claudeDetected: true, live: true, canPrompt: true, demo: false })
  const meeting = [...snap.meetings, ...snap.pastMeetings][0]
  check(!!meeting && meeting.members.includes("claude") && meeting.members.includes("Explore"), `the office shows a meeting (${meeting ? meeting.members.join(", ") : "none"})`)
  const transcript = inputs.find((i) => i.transcript_path)?.transcript_path
  const messages = transcript ? readTranscript(transcript) : []
  check(messages.some((m) => m.role === "user") && messages.some((m) => m.role === "assistant"), `the office chat reads the conversation (${messages.length} messages)`)
  const said = messages.flatMap((m) => (m.role === "assistant" ? m.parts : [])).map((p) => p.text ?? "").join(" ")
  check(said.includes("ZEBRA-4412"), "the briefing reaches Claude (it quotes the team code)")
  check(!JSON.stringify(inputs).includes("The deployment window is Tuesday"), "file contents never reach the bridge")

  // 2. Stop button: the first tool call is refused and Claude stops.
  scenario = "stop"
  inputs.length = 0
  const second = await run("Use the Read tool to read hello.txt and quote it.")
  const toolsRun = inputs.filter((i) => i.hook_event_name === "PostToolUse").length
  check(inputs.some((i) => i.hook_event_name === "PreToolUse") && toolsRun === 0, "Stop: the tool never runs")
  check(!String(second.result?.result ?? "").includes("Tuesday"), "Stop: Claude does not answer with the file")
} catch (err) {
  failures.push(String(err))
  console.error(err)
} finally {
  bridge.dispose()
  // Claude Code keeps the test sessions in its history: remove them with the throwaway folder.
  for (const dir of new Set([...seen].map((p) => dirname(p)))) {
    if (dir.includes("star-claude-e2e-")) rmSync(dir, { recursive: true, force: true })
  }
  rmSync(tmp, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log("\nAll end-to-end checks passed")
process.exit(0)
