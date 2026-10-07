import * as fs from "node:fs"
import * as path from "node:path"
import type { AgentProfile, RosterAgent } from "./protocol"
import { LEAD_GUIDE } from "./team"

const MAX_BRIEFING_CHARS = 24_000
const FOLDER_CARD_TTL_MS = 5 * 60_000

const short = (v: string | undefined, max: number) => (v && v.length > max ? v.slice(0, max - 1) + "…" : v)

function readText(file: string, max: number): string | undefined {
  try {
    const fd = fs.openSync(file, "r")
    try {
      const buf = Buffer.alloc(max)
      const n = fs.readSync(fd, buf, 0, max, 0)
      return buf.subarray(0, n).toString("utf8")
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return undefined
  }
}

const cards = new Map<string, { at: number; text: string }>()

/** What a linked folder is, in a few lines: stack, layout and the start of its instructions. */
export function folderCard(dir: string): string {
  const cached = cards.get(dir)
  if (cached && Date.now() - cached.at < FOLDER_CARD_TTL_MS) return cached.text
  let text: string
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith(".") || e.name === ".github")
    const names = new Set(entries.map((e) => e.name))
    const facts: string[] = []
    const goMod = names.has("go.mod") ? readText(path.join(dir, "go.mod"), 4000) : undefined
    if (goMod) {
      const mod = /^module\s+(\S+)/m.exec(goMod)
      const ver = /^go\s+(\S+)/m.exec(goMod)
      facts.push(`Go module ${mod ? mod[1] : "?"}${ver ? ` (go ${ver[1]})` : ""}`)
      for (const dep of ["sigs.k8s.io/controller-runtime", "k8s.io/client-go", "github.com/operator-framework"]) {
        if (goMod.includes(dep)) facts.push(`uses ${dep}`)
      }
    }
    if (names.has("PROJECT")) {
      const domain = /^domain:\s*(\S+)/m.exec(readText(path.join(dir, "PROJECT"), 2000) ?? "")
      facts.push(`Kubebuilder project${domain ? ` (domain ${domain[1]})` : ""}`)
    }
    if (names.has("package.json")) {
      try {
        facts.push(`Node package ${JSON.parse(readText(path.join(dir, "package.json"), 200_000) ?? "{}").name ?? "?"}`)
      } catch {
        facts.push("Node package")
      }
    }
    if (names.has("Cargo.toml")) facts.push("Rust crate")
    if (names.has("pyproject.toml") || names.has("requirements.txt")) facts.push("Python project")
    if (names.has("Chart.yaml")) facts.push("Helm chart")
    if (names.has("Dockerfile")) facts.push("Dockerfile")
    if (names.has("Makefile")) facts.push("Makefile")
    const layout = entries
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 30)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    const lines: string[] = []
    if (facts.length) lines.push(`Stack: ${facts.join(", ")}.`)
    lines.push(`Top level: ${layout.join(" ") || "(empty)"}`)
    const doc = ["AGENTS.md", "README.md", "readme.md"].find((n) => names.has(n))
    if (doc) {
      const excerpt = (readText(path.join(dir, doc), 1500) ?? "").trim()
      if (excerpt) lines.push(`${doc} (start):\n${excerpt.split("\n").map((l) => `> ${l}`).join("\n")}`)
    }
    text = lines.join("\n")
  } catch {
    text = "Not found on this machine."
  }
  cards.set(dir, { at: Date.now(), text })
  return text
}

export interface BriefingInput {
  /** Agent being briefed: the main agent, or a sub-agent's type. */
  agent: string
  mainAgent: string
  roster: RosterAgent[]
  team: AgentProfile
  own: AgentProfile
}

/** Text added to the context of a session (main agent) or of a sub-agent when it starts. */
export function briefing(input: BriefingInput): string {
  const { agent, mainAgent, roster, team, own } = input
  const lead = agent === mainAgent
  const me = roster.find((a) => a.name === agent)
  const subagents = roster.filter((a) => a.mode !== "primary" && a.name !== agent && !a.hidden)
  const custom = subagents.filter((a) => !a.builtIn)
  const out = ["# Team briefing (Star UI)"]
  if (lead) {
    out.push(`You are **${me?.displayName ?? agent}**, the lead of this session.`)
  } else {
    out.push(`You are **${agent}**${me?.description ? `: ${short(me.description, 400)}` : "."}`)
  }
  if (custom.length || (lead && subagents.length)) {
    out.push("", lead ? "## Your team" : "## Your teammates", lead ? "These sub-agents work with you. Each one owns its role:" : "Other sub-agents of this team:")
    for (const a of lead ? subagents : custom) out.push(`- **${a.name}**: ${short(a.description, 240) ?? "no description"}`)
    out.push(
      "",
      lead
        ? "Delegate each part of the work to the sub-agent whose role fits best, with the Task tool (`subagent_type` = its name), and give it everything it needs: it does not see this conversation. Check what comes back before you answer."
        : "Stay within your role. When part of the work belongs to another role, say so in your final report and name the teammate who should take it.",
    )
    if (lead && custom.length) out.push("", "## Leading the team", LEAD_GUIDE)
  }
  if (team.context.trim()) out.push("", "## Team context", team.context.trim())
  if (own.context.trim()) out.push("", "## Your context", own.context.trim())
  const folders: { path: string; note?: string }[] = []
  for (const f of [...team.folders, ...own.folders]) if (!folders.some((x) => x.path === f.path)) folders.push(f)
  if (folders.length) {
    out.push("", "## Linked folders", "Besides the current project, these folders matter to this team; use absolute paths with your tools:")
    for (const f of folders) out.push("", `### ${path.basename(f.path)}: ${f.path}${f.note ? ` (${f.note})` : ""}`, folderCard(f.path))
  }
  const text = out.join("\n")
  return text.length > MAX_BRIEFING_CHARS ? text.slice(0, MAX_BRIEFING_CHARS - 1) + "…" : text
}

/** True when there is anything worth telling the agent besides its own name. */
export function hasBriefing(input: BriefingInput): boolean {
  const custom = input.roster.some((a) => a.mode !== "primary" && !a.builtIn)
  return custom || !!input.team.context.trim() || !!input.own.context.trim() || input.team.folders.length > 0 || input.own.folders.length > 0
}
