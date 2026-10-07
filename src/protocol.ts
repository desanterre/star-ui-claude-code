// Wire format between the Claude Code hook (hook/star-hook.cjs), the extension and the webview.
// The extension turns hook events into the BridgeEvents below, which only carry short metadata.

export type OfficeState = "idle" | "writing" | "researching" | "executing" | "syncing" | "error"

export type SessionStatus = "busy" | "idle" | "retry" | "offline"
export type ToolStatus = "pending" | "running" | "completed" | "error"
export type AgentMode = "primary" | "subagent" | "all"

export interface RosterAgent {
  name: string
  displayName?: string
  description?: string
  mode: AgentMode
  color?: string
  builtIn?: boolean
  hidden?: boolean
  /** Specialist of another repository (kept for compatibility with the office model). */
  teammate?: boolean
  repo?: string
}

interface Base {
  ts?: number
  dir?: string
}

export type BridgeEvent = Base &
  (
    | { t: "hello"; version: string; project?: string; client?: string; commands?: boolean }
    | { t: "roster"; agents: RosterAgent[] }
    | { t: "session"; sid: string; parentID?: string; title?: string; agent?: string; teammate?: string }
    | { t: "session.deleted"; sid: string }
    | { t: "status"; sid: string; status: SessionStatus; message?: string }
    | { t: "tool"; sid: string; callID: string; tool: string; status: ToolStatus; hint?: string; error?: string }
    | { t: "thinking"; sid: string; kind: "text" | "reasoning" }
    | { t: "agent"; sid: string; agent: string }
    | { t: "ask"; sid: string; rid: string; kind: "permission" | "question"; label?: string }
    | { t: "answered"; sid: string; rid: string }
    | { t: "error"; sid?: string; name?: string; message?: string }
    | { t: "compaction"; sid: string; phase: "start" | "end" }
  )

export interface BridgeSource {
  /** Version of the hook script. */
  plugin?: string
  /** Claude Code process that ran the hook. */
  pid?: number
  parentPid?: number
}

/** What Claude Code sends to a command hook on stdin (only the fields Star UI reads). */
export interface HookInput {
  hook_event_name: string
  session_id: string
  transcript_path?: string
  cwd?: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
  agent_transcript_path?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_use_id?: string
  error?: unknown
  prompt?: string
  source?: string
  reason?: string
  trigger?: string
  type?: string
  notification_type?: string
  message?: string
}

/** What the hook prints back to Claude Code (see Claude Code's hooks reference). */
export interface HookReply {
  continue?: boolean
  stopReason?: string
  hookSpecificOutput?: { hookEventName: string; additionalContext?: string }
}

export interface HookPayload {
  source?: BridgeSource
  input: HookInput
}

/** Outcome of a message sent from the office. */
export interface PromptResult {
  ok: boolean
  error?: string
  sessionID?: string
  /** Shown in the office chat after a successful send. */
  note?: string
}

/** Whose profile: one agent's, or the whole team's (given to every agent). */
export type ProfileTarget = { kind: "agent"; name: string } | { kind: "team" }

export interface MemoryNote {
  id: string
  text: string
  at: number
  /** Agent that saved the note with the `remember` tool. */
  by?: string
}

/** What an agent is told at each turn, besides its role and its teammates. */
export interface AgentProfile {
  context: string
  folders: { path: string; note?: string }[]
  memory: MemoryNote[]
}

/** A conversation as shown in the office chat (texts are truncated). */
export interface TranscriptPart {
  type: "text" | "reasoning" | "tool" | "file" | "subtask"
  text?: string
  tool?: string
  status?: string
  title?: string
  error?: string
}

/** What the office chat shows: one character's conversation, or a whole meeting. */
export type ChatTarget = { kind: "agent"; name: string } | { kind: "meeting"; id: string }

export interface TranscriptMessage {
  id: string
  role: "user" | "assistant"
  /** Character who wrote it; for a brief sent to a sub-agent, the character who delegated. */
  speaker?: string
  /** Addressee of a brief sent to a sub-agent. */
  to?: string
  agent?: string
  time?: number
  error?: string
  parts: TranscriptPart[]
}

export type DetailKind = "idle" | "thinking" | "tool" | "retry" | "error" | "compaction" | "waiting" | "offline"

export interface AgentDetail {
  kind: DetailKind
  tool?: string
  hint?: string
  message?: string
}

/** One character in the office = one Claude Code agent (Claude, Explore, Plan, your custom sub-agents...). */
export interface CharacterView {
  name: string
  displayName?: string
  description?: string
  mode?: AgentMode
  color?: string
  builtIn?: boolean
  teammate?: boolean
  repo?: string
  state: OfficeState
  detail: AgentDetail
  waiting?: { kind: "permission" | "question"; label?: string }
  busy: boolean
  /** Number of sessions currently running with this agent. */
  activeSessions: number
  /** Most relevant session for this agent (running, waiting, or last one). */
  sessionID?: string
  sessionTitle?: string
  sessionDir?: string
  isSubagent: boolean
  /** Root session of the conversation this character takes part in, when others take part too. */
  meetingID?: string
  updatedAt: number
}

/** A conversation where several agents work together: a root session and the sub-agents it started. */
export interface MeetingView {
  id: string
  title?: string
  /** Character names, the agent of the root session first. */
  members: string[]
  busy: boolean
  updatedAt: number
}

export type LogKind = "joined" | "tool" | "done" | "error" | "waiting" | "prompted"

export interface LogEntry {
  ts: number
  kind: LogKind
  agent?: string
  title?: string
  tool?: string
  hint?: string
  message?: string
}

export interface ConnectionInfo {
  /** Star UI's hooks are in Claude Code's settings.json. */
  hooksInstalled: boolean
  /** The Claude Code extension or its config folder is present. */
  claudeDetected: boolean
  live: boolean
  canPrompt: boolean
  lastEventAt?: number
  demo: boolean
}

export interface OfficeSnapshot {
  main: CharacterView | null
  guests: CharacterView[]
  /** Meetings in progress. */
  meetings: MeetingView[]
  /** Finished meetings, newest first. */
  pastMeetings: MeetingView[]
  log: LogEntry[]
  connection: ConnectionInfo
}

export interface WebviewSettings {
  language: string
  officeName: string
  room: "office" | "lodge"
}

export type ToWebview =
  | { type: "init"; settings: WebviewSettings; snapshot: OfficeSnapshot }
  | { type: "snapshot"; snapshot: OfficeSnapshot }
  | { type: "settings"; settings: WebviewSettings }
  | { type: "promptResult"; requestId: string; ok: boolean; error?: string; sessionID?: string; note?: string }
  | {
      type: "transcript"
      requestId: string
      target: ChatTarget
      sessionID?: string
      messages?: TranscriptMessage[]
      error?: string
    }
  | { type: "profile"; requestId: string; target: ProfileTarget; profile?: AgentProfile; error?: string }
  | { type: "profileSaved"; requestId: string; ok: boolean; error?: string; reloadNeeded?: boolean }
  | { type: "folders"; requestId: string; paths: string[] }
  | { type: "briefing"; requestId: string; text?: string; error?: string }

export type WebviewCommand =
  | "connect"
  | "disconnect"
  | "toggleDemo"
  | "openClaude"
  | "openSettings"
  | "createTeam"

export type FromWebview =
  | { type: "ready" }
  | { type: "command"; command: WebviewCommand }
  | { type: "prompt"; requestId: string; agent: string; text: string; continueSession: boolean }
  | { type: "meetingPrompt"; requestId: string; meetingID: string; text: string; stopFirst: boolean }
  | { type: "openSession"; agent: string }
  | { type: "stop"; agent?: string; meetingID?: string }
  | { type: "transcript"; requestId: string; target: ChatTarget }
  | { type: "profileLoad"; requestId: string; target: ProfileTarget }
  | { type: "profileSave"; requestId: string; target: ProfileTarget; context: string; folders: { path: string; note?: string }[] }
  | { type: "profileForget"; requestId: string; target: ProfileTarget; id: string }
  | { type: "pickFolders"; requestId: string }
  | { type: "briefing"; requestId: string; agent: string }
  | { type: "log"; level: "info" | "error"; message: string }
