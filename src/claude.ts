import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { BridgeEvent, HookInput, RosterAgent, TranscriptMessage, TranscriptPart } from "./protocol"
import { colorOf } from "./team"

export const CLAUDE_EXTENSION_ID = "anthropic.claude-code"
/** Name of the hook script once copied next to Star UI's data; it also marks our entries in settings.json. */
export const HOOK_SCRIPT = "star-ui-claude-code-hook.cjs"

/** Every hook event the office listens to. */
export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
] as const
/** Claude Code waits for these: their answer can stop the session or add context. The others run in the background. */
export const ANSWERED_EVENTS = new Set<string>(["SessionStart", "SubagentStart", "PreToolUse", "UserPromptSubmit"])

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p
}

/** Where Star UI keeps its own files: bridges registry, hook script, profiles. */
export function starHome(): string {
  return process.env.STAR_UI_CLAUDE_HOME || path.join(os.homedir(), ".star-ui-claude-code")
}

/** Claude Code's config folder (settings.json, agents/, projects/). */
export function claudeConfigDir(setting?: string): string {
  if (setting && setting.trim()) return path.resolve(expandHome(setting.trim()))
  if (process.env.CLAUDE_CONFIG_DIR) return path.resolve(expandHome(process.env.CLAUDE_CONFIG_DIR))
  return path.join(os.homedir(), ".claude")
}

// ---------- hooks in Claude Code's settings.json ----------

interface HookHandler {
  type: string
  command?: string
  [key: string]: unknown
}
interface HookGroup {
  matcher?: string
  hooks: HookHandler[]
  [key: string]: unknown
}
type Settings = { hooks?: Record<string, HookGroup[]>; permissions?: { additionalDirectories?: string[]; [k: string]: unknown }; [k: string]: unknown }

const posixQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`

/**
 * Command that runs the hook with VS Code's own Node runtime, so nothing else needs to be installed.
 * `runtime` is the extension host's executable (process.execPath).
 */
export function hookCommand(runtime: string, script: string, platform: string = process.platform): { command: string; shell?: string } {
  if (platform === "win32") return { command: `$env:ELECTRON_RUN_AS_NODE='1'; & ${psQuote(runtime)} ${psQuote(script)}`, shell: "powershell" }
  return { command: `ELECTRON_RUN_AS_NODE=1 ${posixQuote(runtime)} ${posixQuote(script)}` }
}

/** Star UI's entries for the "hooks" section of settings.json. */
export function hookEntries(cmd: { command: string; shell?: string }): Record<string, HookGroup[]> {
  const out: Record<string, HookGroup[]> = {}
  for (const event of HOOK_EVENTS) {
    const handler: HookHandler = { type: "command", command: cmd.command, timeout: 5 }
    if (cmd.shell) handler.shell = cmd.shell
    if (!ANSWERED_EVENTS.has(event)) handler.async = true
    out[event] = [{ hooks: [handler] }]
  }
  return out
}

const isOurs = (h: HookHandler | undefined) => !!h && typeof h.command === "string" && h.command.includes(HOOK_SCRIPT)

export function readSettings(file: string): Settings {
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw err
  }
  if (!raw.trim()) return {}
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`${file} is not valid JSON; fix it before connecting.`)
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${file} does not hold a JSON object.`)
  return data as Settings
}

function writeSettings(file: string, data: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let mode = 0o600
  try {
    mode = fs.statSync(file).mode & 0o777
  } catch {}
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode })
  fs.renameSync(tmp, file)
}

function withoutOurs(hooks: Record<string, HookGroup[]> | undefined): Record<string, HookGroup[]> {
  const out: Record<string, HookGroup[]> = {}
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    if (!Array.isArray(groups)) {
      out[event] = groups
      continue
    }
    const kept = groups
      .map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
      .filter((g) => !g || !Array.isArray(g.hooks) || g.hooks.length > 0)
    if (kept.length) out[event] = kept
  }
  return out
}

/** Adds (or refreshes) Star UI's hooks, keeping everything else in settings.json. */
export function installHooks(file: string, entries: Record<string, HookGroup[]>): { changed: boolean } {
  const data = readSettings(file)
  const before = JSON.stringify(data)
  const hooks = withoutOurs(data.hooks)
  for (const [event, groups] of Object.entries(entries)) hooks[event] = [...(hooks[event] ?? []), ...groups]
  data.hooks = hooks
  if (JSON.stringify(data) === before) return { changed: false }
  writeSettings(file, data)
  return { changed: true }
}

/** Removes Star UI's hooks only. */
export function uninstallHooks(file: string): boolean {
  const data = readSettings(file)
  if (!hooksInstalledIn(data)) return false
  const hooks = withoutOurs(data.hooks)
  if (Object.keys(hooks).length) data.hooks = hooks
  else delete data.hooks
  writeSettings(file, data)
  return true
}

function hooksInstalledIn(data: Settings): boolean {
  return Object.values(data.hooks ?? {}).some((groups) => Array.isArray(groups) && groups.some((g) => g && Array.isArray(g.hooks) && g.hooks.some(isOurs)))
}

export function hooksInstalled(file: string): boolean {
  try {
    return hooksInstalledIn(readSettings(file))
  } catch {
    return false
  }
}

/** True when settings.json holds exactly the expected Star UI entries. */
export function hooksCurrent(file: string, entries: Record<string, HookGroup[]>): boolean {
  try {
    const data = readSettings(file)
    for (const [event, groups] of Object.entries(entries)) {
      const ours = (data.hooks?.[event] ?? []).flatMap((g) => (g && Array.isArray(g.hooks) ? g.hooks.filter(isOurs) : []))
      if (JSON.stringify(ours) !== JSON.stringify(groups.flatMap((g) => g.hooks))) return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Keeps `permissions.additionalDirectories` in sync with the team's linked folders.
 * `previous` is what Star UI added last time, so folders added by hand are left alone.
 */
export function syncAdditionalDirectories(file: string, folders: string[], previous: string[]): boolean {
  const data = readSettings(file)
  const current = Array.isArray(data.permissions?.additionalDirectories) ? data.permissions!.additionalDirectories!.filter((d) => typeof d === "string") : []
  const kept = current.filter((d) => !previous.includes(d))
  const next = [...kept, ...folders.filter((f) => !kept.includes(f))]
  if (JSON.stringify(next) === JSON.stringify(current)) return false
  data.permissions = { ...(data.permissions ?? {}) }
  if (next.length) data.permissions.additionalDirectories = next
  else delete data.permissions.additionalDirectories
  if (!Object.keys(data.permissions).length) delete data.permissions
  writeSettings(file, data)
  return true
}

// ---------- agents ----------

/** Claude Code's own agents. "claude" is the main conversation. */
export const BUILT_IN_AGENTS: RosterAgent[] = [
  { name: "claude", displayName: "Claude", mode: "primary", builtIn: true, color: "#d97757", description: "Claude Code's main conversation: plans the work and delegates to sub-agents." },
  { name: "general-purpose", mode: "subagent", builtIn: true, description: "General-purpose sub-agent for complex, multi-step tasks." },
  { name: "Explore", mode: "subagent", builtIn: true, description: "Fast, read-only exploration of the codebase." },
  { name: "Plan", mode: "subagent", builtIn: true, description: "Researches the codebase to plan a change before it is made." },
]

/** Parses the YAML front matter of a Claude Code agent file (simple `key: value` lines). */
export function parseFrontMatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const out: Record<string, string> = {}
  if (!m) return out
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    let value = kv[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    out[kv[1]] = value
  }
  return out
}

/** Custom sub-agents from agents/ folders (later folders win, like Claude Code: project over user). */
export function readAgents(dirs: string[]): RosterAgent[] {
  const byName = new Map<string, RosterAgent>()
  for (const dir of dirs) {
    let names: string[] = []
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".md"))
    } catch {
      continue
    }
    for (const file of names) {
      try {
        const meta = parseFrontMatter(fs.readFileSync(path.join(dir, file), "utf8"))
        const name = (meta.name || path.basename(file, ".md")).trim()
        if (!/^[\w.-]{1,60}$/.test(name)) continue
        byName.set(name, {
          name,
          mode: "subagent",
          description: meta.description ? meta.description.slice(0, 300) : undefined,
          color: colorOf(meta.color),
        })
      } catch {}
    }
  }
  return [...byName.values()]
}

export function roster(configDir: string, workspaceDirs: string[]): RosterAgent[] {
  const custom = readAgents([path.join(configDir, "agents"), ...workspaceDirs.map((d) => path.join(d, ".claude", "agents"))])
  const names = new Set(custom.map((a) => a.name))
  return [...BUILT_IN_AGENTS.filter((a) => !names.has(a.name)), ...custom]
}

// ---------- hook events -> office events ----------

const short = (v: unknown, max: number): string | undefined => {
  if (v === undefined || v === null) return undefined
  const s = String(v).replace(/\s+/g, " ").trim()
  if (!s) return undefined
  return s.length > max ? s.slice(0, max - 1) + "…" : s
}

const host = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

/** A few words about a tool call, for the office: a file name, a pattern, a command... */
export function toolHint(tool: string | undefined, input: Record<string, unknown> | undefined): string | undefined {
  const i = input ?? {}
  const str = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : undefined)
  const file = str("file_path") ?? str("notebook_path") ?? str("path")
  if ((tool === "Task" || tool === "Agent") && str("subagent_type")) return short(`${str("subagent_type")}: ${str("description") ?? ""}`, 60)
  return short(str("description") ?? (file && path.basename(file)) ?? str("pattern") ?? str("query") ?? (str("url") && host(str("url")!)) ?? str("command") ?? str("skill"), 60)
}

/** Translates one Claude Code hook event into office events. */
export function hookEvents(input: HookInput, mainAgent = "claude"): BridgeEvent[] {
  const event = input.hook_event_name
  const root = input.session_id
  const dir = input.cwd
  const sub = input.agent_id
  const sid = sub ?? root
  const out: BridgeEvent[] = []
  const ensureRoot = () => out.push({ t: "session", sid: root, agent: mainAgent, dir })
  const ensureSub = () => {
    if (sub) out.push({ t: "session", sid: sub, parentID: root, agent: input.agent_type || "general-purpose", dir })
  }
  switch (event) {
    case "SessionStart":
      out.push({ t: "session", sid: root, agent: input.agent_type || mainAgent, dir })
      if (input.source === "compact") out.push({ t: "compaction", sid: root, phase: "end" })
      break
    case "UserPromptSubmit":
      out.push({ t: "session", sid: root, agent: mainAgent, dir, title: short(input.prompt, 80) })
      out.push({ t: "status", sid: root, status: "busy" })
      out.push({ t: "answered", sid: root, rid: "*" })
      break
    case "PreToolUse":
      ensureRoot()
      ensureSub()
      out.push({ t: "status", sid, status: "busy" })
      out.push({ t: "tool", sid, callID: input.tool_use_id || `${sid}:${input.tool_name}`, tool: input.tool_name || "tool", status: "running", hint: toolHint(input.tool_name, input.tool_input) })
      break
    case "PostToolUse":
    case "PostToolUseFailure":
      ensureRoot()
      ensureSub()
      out.push({
        t: "tool",
        sid,
        callID: input.tool_use_id || `${sid}:${input.tool_name}`,
        tool: input.tool_name || "tool",
        status: event === "PostToolUse" ? "completed" : "error",
        error: event === "PostToolUse" ? undefined : short(input.error, 120),
      })
      out.push({ t: "answered", sid, rid: "*" })
      break
    case "PermissionRequest":
      ensureRoot()
      ensureSub()
      out.push({ t: "ask", sid, rid: `perm:${input.tool_use_id ?? input.tool_name ?? "tool"}`, kind: "permission", label: short(input.tool_name, 60) })
      break
    case "Notification": {
      const kind = input.notification_type ?? input.type
      if (kind === "permission_prompt") out.push({ t: "ask", sid: root, rid: "notification", kind: "permission", label: short(input.message, 60) })
      else if (kind === "elicitation_dialog") out.push({ t: "ask", sid: root, rid: "notification", kind: "question", label: short(input.message, 60) })
      else if (kind === "idle_prompt") out.push({ t: "status", sid: root, status: "idle" })
      break
    }
    case "Stop":
    case "SessionEnd":
      out.push({ t: "status", sid: root, status: "idle" })
      out.push({ t: "answered", sid: root, rid: "*" })
      break
    case "SubagentStart":
      ensureRoot()
      ensureSub()
      if (sub) out.push({ t: "status", sid: sub, status: "busy" })
      break
    case "SubagentStop":
      if (sub) {
        out.push({ t: "status", sid: sub, status: "idle" })
        out.push({ t: "answered", sid: sub, rid: "*" })
      }
      break
    case "PreCompact":
      out.push({ t: "compaction", sid: root, phase: "start" })
      break
    case "PostCompact":
      out.push({ t: "compaction", sid: root, phase: "end" })
      break
  }
  for (const ev of out) ev.dir = dir
  return out
}

// ---------- transcripts ----------

const MAX_TRANSCRIPT_BYTES = 6 * 1024 * 1024
const MAX_MESSAGES = 80
const MAX_PART_CHARS = 6000
const MAX_TOTAL_CHARS = 400_000

/** Path of a sub-agent's conversation, next to its session's transcript. */
export function subagentTranscript(mainTranscript: string, sessionId: string, agentId: string): string | undefined {
  const base = path.join(path.dirname(mainTranscript), sessionId, "subagents")
  const leaf = `agent-${agentId}.jsonl`
  const direct = path.join(base, leaf)
  if (fs.existsSync(direct)) return direct
  try {
    for (const d of fs.readdirSync(base, { withFileTypes: true })) {
      if (d.isDirectory() && fs.existsSync(path.join(base, d.name, leaf))) return path.join(base, d.name, leaf)
    }
  } catch {}
  return undefined
}

function readTail(file: string, max: number): string {
  const fd = fs.openSync(file, "r")
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - max)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    const text = buf.toString("utf8")
    // Started in the middle of a line: drop it.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text
  } finally {
    fs.closeSync(fd)
  }
}

const clip = (s: string) => (s.length > MAX_PART_CHARS ? "…" + s.slice(-(MAX_PART_CHARS - 1)) : s)

/** A Claude Code transcript (JSONL), as messages for the office chat. */
export function readTranscript(file: string): TranscriptMessage[] {
  let text: string
  try {
    text = readTail(file, MAX_TRANSCRIPT_BYTES)
  } catch {
    return []
  }
  const messages: TranscriptMessage[] = []
  const byId = new Map<string, TranscriptMessage>()
  const tools = new Map<string, TranscriptPart>()
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!entry || (entry.type !== "user" && entry.type !== "assistant") || entry.isMeta || entry.isCompactSummary) continue
    const msg = entry.message
    if (!msg) continue
    const time = Date.parse(entry.timestamp) || undefined
    const content: any[] = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : Array.isArray(msg.content) ? msg.content : []
    if (entry.type === "user") {
      const parts: TranscriptPart[] = []
      for (const c of content) {
        if (c?.type === "tool_result") {
          const tool = tools.get(c.tool_use_id)
          if (tool) tool.status = c.is_error ? "error" : "completed"
        } else if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
          // Commands and reminders Claude Code adds to the prompt are not what the user typed.
          if (/^<(command-|local-command-|system-reminder)/.test(c.text.trim())) continue
          parts.push({ type: "text", text: clip(c.text) })
        }
      }
      if (parts.length) messages.push({ id: entry.uuid ?? `u${messages.length}`, role: "user", time, parts })
      continue
    }
    const id = msg.id ?? entry.uuid ?? `a${messages.length}`
    let target = byId.get(id)
    if (!target) {
      target = { id, role: "assistant", time, parts: [] }
      byId.set(id, target)
      messages.push(target)
    }
    for (const c of content) {
      if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) target.parts.push({ type: "text", text: clip(c.text) })
      else if (c?.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim()) target.parts.push({ type: "reasoning", text: clip(c.thinking) })
      else if (c?.type === "tool_use") {
        const part: TranscriptPart = { type: "tool", tool: c.name, status: "running", title: toolHint(c.name, c.input) }
        if ((c.name === "Task" || c.name === "Agent") && typeof c.input?.prompt === "string") {
          part.type = "subtask"
          part.tool = c.input.subagent_type ?? "general-purpose"
          part.text = clip(c.input.prompt)
        }
        tools.set(c.id, part)
        target.parts.push(part)
      }
    }
    if (entry.isApiErrorMessage || entry.error) target.error = short(entry.error ?? "API error", 300)
  }
  const out = messages.filter((m) => m.parts.length || m.error).slice(-MAX_MESSAGES)
  while (out.length > 1 && JSON.stringify(out).length > MAX_TOTAL_CHARS) out.shift()
  return out
}
