// star-ui-claude-code hook v0.1.0
//
// Installed by the "Star UI for Claude Code" VS Code extension (https://github.com/desanterre/star-ui-claude-code).
//
// Claude Code runs this script for each hook event listed in its settings.json. The script:
//   1. forwards a trimmed copy of the event to the Star Office of every open VS Code window
//      (local bridges listed in ~/.star-ui-claude-code/bridges/);
//   2. prints their answer back to Claude Code: stop the session (Stop button), or context to add
//      at the start of a session or a sub-agent (team briefing).
//
// - Traffic only goes to 127.0.0.1.
// - File contents (Write/Edit payloads) and tool results are never forwarded.
// - It never fails: on any error it exits with code 0 and prints nothing, so Claude Code carries on.
"use strict"

const fs = require("fs")
const http = require("http")
const os = require("os")
const path = require("path")

const VERSION = "0.1.0"
const HOME = process.env.STAR_UI_CLAUDE_HOME || path.join(os.homedir(), ".star-ui-claude-code")
const REGISTRY_DIR = path.join(HOME, "bridges")
const MAX_INPUT = 4 * 1024 * 1024
// Claude Code waits for these: they can stop the session or add context.
const ANSWERED = new Set(["PreToolUse", "SessionStart", "SubagentStart", "UserPromptSubmit"])

function short(value, max) {
  if (value === undefined || value === null) return undefined
  const s = String(value)
  return s.length > max ? s.slice(0, max - 1) + "…" : s
}

// Only what the office shows: names, paths and short hints. Never file contents.
function trimToolInput(input) {
  if (!input || typeof input !== "object") return undefined
  const out = {}
  for (const key of ["file_path", "path", "notebook_path", "pattern", "glob", "url", "query", "subagent_type", "description", "skill", "plan"]) {
    if (typeof input[key] === "string") out[key] = short(input[key], 300)
  }
  if (typeof input.command === "string") out.command = short(input.command, 300)
  if (typeof input.prompt === "string") out.prompt = short(input.prompt, 4000)
  return out
}

function trim(input) {
  return {
    hook_event_name: input.hook_event_name,
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    permission_mode: input.permission_mode,
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    agent_transcript_path: input.agent_transcript_path,
    tool_name: input.tool_name,
    tool_input: trimToolInput(input.tool_input),
    tool_use_id: input.tool_use_id,
    error: short(typeof input.error === "string" ? input.error : input.error && input.error.message, 300),
    prompt: short(input.prompt, 500),
    source: input.source,
    reason: input.reason,
    trigger: input.trigger,
    type: input.type,
    notification_type: input.notification_type,
    message: short(input.message, 300),
  }
}

function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return !!err && err.code === "EPERM"
  }
}

function bridges() {
  const out = []
  let names = []
  try {
    names = fs.readdirSync(REGISTRY_DIR)
  } catch {
    return out
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    try {
      const info = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, name), "utf8"))
      if (info && Number.isInteger(info.port) && typeof info.token === "string" && alive(info.pid)) out.push(info)
    } catch {}
  }
  return out
}

// Plain node:http without an agent: never routed through an HTTP(S) proxy.
function post(bridge, body, timeoutMs) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body)
    const req = http.request(
      {
        host: "127.0.0.1",
        port: bridge.port,
        path: "/v1/hook",
        method: "POST",
        agent: false,
        headers: {
          authorization: `Bearer ${bridge.token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => {
          try {
            resolve(res.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString("utf8")).reply : undefined)
          } catch {
            resolve(undefined)
          }
        })
        res.on("error", () => resolve(undefined))
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy())
    req.on("error", () => resolve(undefined))
    req.end(payload)
  })
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    process.stdin.on("data", (c) => {
      size += c.length
      if (size <= MAX_INPUT) chunks.push(c)
    })
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    process.stdin.on("error", () => resolve(""))
  })
}

// One answer for Claude Code, whatever the number of VS Code windows.
function merge(event, replies) {
  const out = {}
  const stop = replies.find((r) => r && r.continue === false)
  if (stop) {
    out.continue = false
    out.stopReason = stop.stopReason || "Stopped from Star UI."
  }
  const context = replies.map((r) => r && r.hookSpecificOutput && r.hookSpecificOutput.additionalContext).find((c) => typeof c === "string" && c)
  if (context) out.hookSpecificOutput = { hookEventName: event, additionalContext: context }
  return Object.keys(out).length ? out : undefined
}

async function main() {
  const raw = await readStdin()
  const input = JSON.parse(raw)
  if (!input || typeof input.hook_event_name !== "string" || typeof input.session_id !== "string") return
  const targets = bridges()
  if (!targets.length) return
  const answered = ANSWERED.has(input.hook_event_name)
  const body = { source: { plugin: VERSION, pid: process.ppid }, input: trim(input) }
  const replies = await Promise.all(targets.map((b) => post(b, body, answered ? 2000 : 1000)))
  const reply = answered ? merge(input.hook_event_name, replies) : undefined
  if (reply) process.stdout.write(JSON.stringify(reply))
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))
