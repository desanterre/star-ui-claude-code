import * as fs from "node:fs"
import * as path from "node:path"
import * as vscode from "vscode"
import { briefing, hasBriefing } from "./briefing"
import { Bridge } from "./bridge"
import {
  CLAUDE_EXTENSION_ID,
  HOOK_SCRIPT,
  claudeConfigDir,
  hookCommand,
  hookEntries,
  hookEvents,
  hooksCurrent,
  hooksInstalled,
  installHooks,
  readTranscript,
  roster,
  starHome,
  subagentTranscript,
  syncAdditionalDirectories,
  uninstallHooks,
} from "./claude"
import { DemoDriver } from "./demo"
import { OfficeModel } from "./office"
import { forgetNote, profilesFile, readProfile, saveProfile } from "./profiles"
import type {
  BridgeEvent,
  BridgeSource,
  ConnectionInfo,
  FromWebview,
  HookPayload,
  HookReply,
  OfficeSnapshot,
  ProfileTarget,
  PromptResult,
  RosterAgent,
  ToWebview,
  TranscriptMessage,
  WebviewCommand,
  WebviewSettings,
} from "./protocol"
import { ROLE_TEMPLATES, TEAM_PRESETS, writeRoles } from "./team"
import { renderOfficeHtml } from "./webview"

const VIEW_ID = "starUiClaude.office"
const CONFIG = "starUiClaude"
/** Character of Claude Code's main conversation. */
const MAIN_AGENT = "claude"
const STOP_REASON = "Stopped from the Star Office."
/** A stop request is forgotten if Claude does not reach a next step in this time. */
const STOP_TTL_MS = 10 * 60_000
/** Activity seen within this window counts as a live connection. */
const LIVE_MS = 30 * 60_000

export function activate(context: vscode.ExtensionContext): void {
  const office = new StarOffice(context)
  context.subscriptions.push(office)
  void office.start()
}

export function deactivate(): void {}

const validTarget = (t: ProfileTarget | undefined): t is ProfileTarget =>
  !!t && (t.kind === "team" || (t.kind === "agent" && typeof t.name === "string" && /^[\w.-]{1,60}$/.test(t.name)))

class StarOffice implements vscode.Disposable, vscode.WebviewViewProvider {
  private readonly output = vscode.window.createOutputChannel("Star UI for Claude Code")
  private readonly model: OfficeModel
  private readonly bridge: Bridge
  private readonly demo: DemoDriver
  private readonly webviews = new Set<vscode.Webview>()
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
  private panel?: vscode.WebviewPanel
  private disposables: vscode.Disposable[] = []
  private broadcastTimer?: NodeJS.Timeout
  private ticker?: NodeJS.Timeout
  private lastSent = ""
  private live?: boolean
  private agents: RosterAgent[] = []
  private rosterKey = ""
  /** Transcript file of each session seen in a hook (sub-agents are found next to their root). */
  private readonly transcripts = new Map<string, string>()
  /** Root sessions the user asked to stop, with the time of the request. */
  private readonly stops = new Map<string, number>()
  private readonly diagnostics = { webviewReady: 0, webviewErrors: [] as string[], hookEvents: 0 }

  constructor(private readonly context: vscode.ExtensionContext) {
    this.model = new OfficeModel({ accept: (_source, dir) => this.accept(dir), mainAgent: MAIN_AGENT })
    this.applyModelOptions()
    this.bridge = new Bridge(starHome(), (payload) => this.onHook(payload), context.extension.packageJSON.version)
    this.demo = new DemoDriver((ev) => this.apply([ev], { pid: -1, parentPid: process.pid }))
  }

  async start(): Promise<void> {
    const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
      this.disposables.push(vscode.commands.registerCommand(id, fn))
    reg("starUiClaude.openOffice", () => this.openPanel())
    reg("starUiClaude.connect", () => this.connect())
    reg("starUiClaude.disconnect", () => this.disconnect())
    reg("starUiClaude.toggleDemo", () => this.toggleDemo())
    reg("starUiClaude.createTeam", () => this.createTeam())
    reg("starUiClaude.openClaude", () => this.openClaude())
    reg("starUiClaude.showLog", () => this.output.show())
    // Not contributed to the palette: used by the integration tests and for bug reports.
    reg("starUiClaude.diagnostics", () => ({ ...this.diagnostics, bridgePort: this.bridge.port, snapshot: this.snapshot() }))

    // Activity bar entry: an empty view whose welcome content holds the main actions.
    // Clicking the ★ icon opens the office itself.
    const home = vscode.window.createTreeView("starUiClaude.home", { treeDataProvider: { getTreeItem: (e: vscode.TreeItem) => e, getChildren: () => [] } })
    home.onDidChangeVisibility((e) => {
      if (e.visible) this.openPanel(true)
    })
    this.disposables.push(
      home,
      vscode.window.registerWebviewViewProvider(VIEW_ID, this, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration(CONFIG)) return
        this.applyModelOptions()
        this.refreshRoster()
        this.post({ type: "settings", settings: this.settings() })
        this.scheduleBroadcast()
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refreshRoster()),
    )

    this.statusBar.command = "starUiClaude.openOffice"
    this.refreshRoster()
    this.updateStatusBar(this.snapshot())

    try {
      await this.bridge.start()
      this.log(`Bridge listening on 127.0.0.1:${this.bridge.port} (${this.bridge.registryFile})`)
    } catch (err) {
      this.log(`Could not start the local bridge: ${String(err)}`)
      void vscode.window.showErrorMessage(`Star UI for Claude Code: could not start the local bridge (${String(err)}).`)
    }

    let tick = 0
    this.ticker = setInterval(() => {
      this.model.prune()
      // Agent files can change at any time (Claude Code's /agents, the team command, by hand).
      if (++tick % 10 === 0) this.refreshRoster()
      this.scheduleBroadcast()
    }, 1000)

    this.refreshHooks()
    if (!this.context.globalState.get("welcomed")) {
      await this.context.globalState.update("welcomed", true)
      this.openPanel(true)
    }
    await this.maybeOfferConnect()
  }

  dispose(): void {
    this.demo.stop()
    this.bridge.dispose()
    if (this.ticker) clearInterval(this.ticker)
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer)
    this.panel?.dispose()
    this.statusBar.dispose()
    this.output.dispose()
    for (const d of this.disposables) d.dispose()
  }

  // ---------- webviews ----------
  resolveWebviewView(view: vscode.WebviewView): void {
    this.attach(view.webview)
    view.onDidDispose(() => this.webviews.delete(view.webview))
  }

  private openPanel(preserveFocus = false): void {
    if (this.panel) {
      try {
        this.panel.reveal(undefined, preserveFocus)
        return
      } catch {
        // Closed a moment ago: its dispose event has not reached us yet.
        this.panel = undefined
      }
    }
    const panel = vscode.window.createWebviewPanel("starUiClaude.officePanel", "Claude Office", { viewColumn: vscode.ViewColumn.Active, preserveFocus }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    })
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "images", "icon.png")
    this.panel = panel
    this.attach(panel.webview)
    panel.onDidDispose(() => {
      this.webviews.delete(panel.webview)
      this.panel = undefined
    })
  }

  private attach(webview: vscode.Webview): void {
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media")
    webview.options = { enableScripts: true, localResourceRoots: [media] }
    const settings = this.settings()
    webview.html = renderOfficeHtml({
      mediaUri: webview.asWebviewUri(media).toString(),
      cspSource: webview.cspSource,
      language: settings.language,
      officeName: settings.officeName,
      room: settings.room,
    })
    webview.onDidReceiveMessage((msg: FromWebview) => this.onMessage(webview, msg))
    this.webviews.add(webview)
  }

  private async onMessage(webview: vscode.Webview, msg: FromWebview): Promise<void> {
    switch (msg?.type) {
      case "ready":
        await webview.postMessage({ type: "init", settings: this.settings(), snapshot: this.snapshot() } satisfies ToWebview)
        return
      case "command":
        await this.runWebviewCommand(msg.command)
        return
      case "prompt": {
        const result = await this.prompt(msg.agent, msg.text, msg.continueSession)
        await webview.postMessage({ type: "promptResult", requestId: msg.requestId, ...result } satisfies ToWebview)
        return
      }
      case "openSession":
        return this.openSession(msg.agent)
      case "stop":
        this.stop(msg.agent, msg.meetingID)
        return
      case "transcript": {
        const reply = msg.target.kind === "meeting" ? this.meetingTranscript(msg.target.id) : this.transcript(msg.target.name)
        await webview.postMessage({ type: "transcript", requestId: msg.requestId, target: msg.target, ...reply } satisfies ToWebview)
        return
      }
      case "meetingPrompt": {
        const result = await this.meetingPrompt(msg.meetingID, msg.text, msg.stopFirst)
        await webview.postMessage({ type: "promptResult", requestId: msg.requestId, ...result } satisfies ToWebview)
        return
      }
      case "profileLoad": {
        const reply = this.loadProfile(msg.target)
        await webview.postMessage({ type: "profile", requestId: msg.requestId, target: msg.target, ...reply } satisfies ToWebview)
        return
      }
      case "profileSave": {
        const reply = this.saveProfile(msg.target, msg.context, msg.folders)
        await webview.postMessage({ type: "profileSaved", requestId: msg.requestId, ...reply } satisfies ToWebview)
        return
      }
      case "profileForget": {
        try {
          if (validTarget(msg.target)) forgetNote(profilesFile(starHome()), msg.target, String(msg.id))
        } catch (err) {
          this.log(`Could not delete the note: ${String(err)}`)
        }
        const reply = this.loadProfile(msg.target)
        await webview.postMessage({ type: "profile", requestId: msg.requestId, target: msg.target, ...reply } satisfies ToWebview)
        return
      }
      case "pickFolders": {
        const uris = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: true,
          openLabel: "Link",
          title: "Folders the agents should know about",
          defaultUri: vscode.workspace.workspaceFolders?.[0] ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, "..") : undefined,
        })
        await webview.postMessage({ type: "folders", requestId: msg.requestId, paths: (uris ?? []).map((u) => u.fsPath) } satisfies ToWebview)
        return
      }
      case "briefing": {
        await webview.postMessage({ type: "briefing", requestId: msg.requestId, text: this.briefingFor(msg.agent) } satisfies ToWebview)
        return
      }
      case "log":
        if (msg.level === "error") this.diagnostics.webviewErrors.push(String(msg.message).slice(0, 500))
        else if (msg.message === "office ready") this.diagnostics.webviewReady++
        this.log(`[webview] ${msg.level}: ${String(msg.message).slice(0, 500)}`)
        return
    }
  }

  private runWebviewCommand(command: WebviewCommand): unknown {
    switch (command) {
      case "connect":
        return this.connect()
      case "disconnect":
        return this.disconnect()
      case "toggleDemo":
        return this.toggleDemo()
      case "openClaude":
        return this.openClaude()
      case "createTeam":
        return this.createTeam()
      case "openSettings":
        return vscode.commands.executeCommand("workbench.action.openSettings", CONFIG)
    }
  }

  private post(msg: ToWebview): void {
    for (const webview of this.webviews) void webview.postMessage(msg)
  }

  private scheduleBroadcast(): void {
    if (this.broadcastTimer) return
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = undefined
      const snapshot = this.snapshot()
      // The timestamp moves on every event; compare without it to avoid useless repaints.
      const key = JSON.stringify({ ...snapshot, connection: { ...snapshot.connection, lastEventAt: 0 } })
      this.updateStatusBar(snapshot)
      if (key === this.lastSent) return
      this.lastSent = key
      this.post({ type: "snapshot", snapshot })
    }, 120)
  }

  // ---------- Claude Code hooks ----------
  private onHook(payload: HookPayload): HookReply | undefined {
    const input = payload.input
    if (typeof input.session_id !== "string" || !this.accept(input.cwd)) return undefined
    this.diagnostics.hookEvents++
    const root = input.session_id
    if (input.transcript_path) this.transcripts.set(root, input.transcript_path)
    if (input.agent_id && input.agent_transcript_path) this.transcripts.set(input.agent_id, input.agent_transcript_path)
    if (!this.demo.active) this.apply(hookEvents(input, MAIN_AGENT), payload.source)

    const event = input.hook_event_name
    const stopAt = this.stops.get(root)
    if (stopAt && Date.now() - stopAt > STOP_TTL_MS) this.stops.delete(root)
    if (event === "UserPromptSubmit" || event === "SessionStart") this.stops.delete(root)
    if ((event === "PreToolUse" || event === "SubagentStart") && this.stops.has(root)) {
      this.log(`Stopping session ${root}${input.agent_id ? ` (sub-agent ${input.agent_type})` : ""}`)
      const idle: BridgeEvent[] = [{ t: "status", sid: root, status: "idle" }]
      if (input.agent_id) idle.push({ t: "status", sid: input.agent_id, status: "idle" })
      this.apply(idle, payload.source)
      return { continue: false, stopReason: STOP_REASON }
    }
    if (event === "SessionStart" || event === "SubagentStart") {
      const agent = event === "SessionStart" ? input.agent_type || MAIN_AGENT : input.agent_type || "general-purpose"
      const text = this.briefingFor(agent, true)
      if (text) return { hookSpecificOutput: { hookEventName: event, additionalContext: text } }
    }
    return undefined
  }

  private apply(events: BridgeEvent[], source: BridgeSource | undefined): void {
    let changed = false
    const now = Date.now()
    for (const ev of events) {
      try {
        if (this.model.apply(ev, now, source)) changed = true
      } catch (err) {
        this.log(`Ignored malformed event: ${String(err)}`)
      }
    }
    if (changed) this.scheduleBroadcast()
  }

  /** Does a Claude Code session working in `dir` belong to this window? */
  private accept(dir: string | undefined): boolean {
    if (this.cfg().get<string>("scope", "workspace") === "all") return true
    const folders = vscode.workspace.workspaceFolders ?? []
    if (!dir || !folders.length) return true
    return folders.some((f) => isInside(dir, f.uri.fsPath))
  }

  private refreshRoster(): void {
    const agents = roster(
      this.configDir(),
      (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    )
    const key = JSON.stringify(agents)
    this.agents = agents
    if (key === this.rosterKey || this.demo.active) return
    this.rosterKey = key
    this.apply([{ t: "roster", agents }], undefined)
  }

  private configDir(): string {
    return claudeConfigDir(this.cfg().get<string>("claudeConfigDir"))
  }

  private settingsFile(): string {
    return path.join(this.configDir(), "settings.json")
  }

  private hookScript(): string {
    return path.join(starHome(), HOOK_SCRIPT)
  }

  private expectedHooks() {
    return hookEntries(hookCommand(process.execPath, this.hookScript()))
  }

  /** Copies the hook script next to Star UI's data, where its path never changes. */
  private copyHookScript(): boolean {
    const source = path.join(this.context.extensionPath, "hook", "star-hook.cjs")
    const target = this.hookScript()
    const content = fs.readFileSync(source)
    try {
      if (fs.readFileSync(target).equals(content)) return false
    } catch {}
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, { mode: 0o644 })
    return true
  }

  /** Keeps an installed hook in step with this version of the extension and with VS Code's runtime path. */
  private refreshHooks(): void {
    const file = this.settingsFile()
    if (!hooksInstalled(file)) return
    try {
      const scriptChanged = this.copyHookScript()
      const entries = this.expectedHooks()
      if (!hooksCurrent(file, entries)) {
        installHooks(file, entries)
        this.log("Updated the Claude Code hooks (new runtime path or new events)")
      } else if (scriptChanged) {
        this.log("Updated the hook script")
      }
    } catch (err) {
      this.log(`Could not refresh the Claude Code hooks: ${String(err)}`)
    }
  }

  private applyModelOptions(): void {
    const cfg = this.cfg()
    this.model.opts.showBuiltInAgents = cfg.get<boolean>("showBuiltInAgents", true)
    this.model.opts.lingerMs = Math.max(0, cfg.get<number>("lingerSeconds", 20)) * 1000
  }

  private claudeInstalled(): boolean {
    return !!vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)
  }

  private connection(): ConnectionInfo {
    const lastEventAt = this.model.lastEventAt
    const installed = hooksInstalled(this.settingsFile())
    return {
      hooksInstalled: installed,
      claudeDetected: this.claudeInstalled() || fs.existsSync(this.configDir()),
      live: installed && !this.demo.active && !!lastEventAt && Date.now() - lastEventAt < LIVE_MS,
      canPrompt: this.demo.active || this.claudeInstalled(),
      lastEventAt,
      demo: this.demo.active,
    }
  }

  private snapshot(): OfficeSnapshot {
    return this.model.snapshot(this.connection())
  }

  private settings(): WebviewSettings {
    const cfg = this.cfg()
    const pref = cfg.get<string>("language", "en")
    return {
      language: pref === "auto" ? (vscode.env.language.startsWith("fr") ? "fr" : "en") : pref === "fr" ? "fr" : "en",
      officeName: cfg.get<string>("officeName", ""),
      room: cfg.get<string>("room", "office") === "lodge" ? "lodge" : "office",
    }
  }

  private updateStatusBar(snapshot: OfficeSnapshot): void {
    if (snapshot.connection.live !== this.live) {
      // Hides "Try the demo" in the ★ view while Claude Code is connected.
      this.live = snapshot.connection.live
      void vscode.commands.executeCommand("setContext", "starUiClaude.live", this.live)
    }
    if (!this.cfg().get<boolean>("statusBar", true)) {
      this.statusBar.hide()
      return
    }
    const chars = [snapshot.main, ...snapshot.guests].filter((c) => !!c)
    const busy = chars.filter((c) => c!.busy).length
    const waiting = chars.filter((c) => c!.waiting).length
    this.statusBar.text = waiting ? `$(bell-dot) Claude Office · ${waiting}` : busy ? `$(sync~spin) Claude Office · ${busy}` : "$(star-full) Claude Office"
    this.statusBar.tooltip = waiting
      ? `${waiting} agent(s) waiting for you in Claude Code`
      : busy
        ? `${busy} agent(s) at work`
        : snapshot.connection.hooksInstalled
          ? "Open the Claude Office"
          : "Star Office is not connected to Claude Code"
    this.statusBar.backgroundColor = waiting ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined
    this.statusBar.show()
  }

  // ---------- talking to Claude Code ----------
  private async prompt(agent: string, text: string, continueSession: boolean): Promise<PromptResult> {
    const clean = String(text ?? "").trim()
    if (!clean) return { ok: false, error: "Empty message" }
    if (this.demo.active) {
      const sid = this.demo.prompt(agent, clean)
      this.model.notePrompt(agent, clean)
      this.scheduleBroadcast()
      return { ok: true, sessionID: sid }
    }
    const char = this.model.getCharacter(agent)
    const sub = agent !== MAIN_AGENT
    // Sub-agents are only reached through the main conversation: Claude delegates to them.
    const message = sub ? `Use the ${agent} sub-agent for this: ${clean}` : clean
    const sessionID = continueSession && !sub ? char?.sessionID : undefined
    return this.openInClaude(message, sessionID, agent, clean)
  }

  /**
   * Opens a Claude Code conversation with the message ready to send: a new one, or an existing one.
   * Claude Code does not let other extensions send a message, and leaves an already open
   * conversation untouched, so the message is also put in the clipboard.
   */
  private async openInClaude(message: string, sessionID: string | undefined, agent: string, original: string): Promise<PromptResult> {
    if (!this.claudeInstalled()) return { ok: false, error: "Claude Code is not installed in this VS Code." }
    try {
      await vscode.env.clipboard.writeText(message)
      await vscode.commands.executeCommand("claude-vscode.editor.open", sessionID, message)
      this.model.notePrompt(agent, original)
      this.scheduleBroadcast()
      this.log(`Opened ${sessionID ? `session ${sessionID}` : "a new conversation"} in Claude Code for ${agent}`)
      return { ok: true, sessionID, note: sessionID ? "resumed" : "prefilled" }
    } catch (err) {
      this.log(`Could not open Claude Code: ${String(err)}`)
      return { ok: false, error: `Could not open Claude Code (${String(err)}).` }
    }
  }

  /** Stops a meeting, one character's running sessions, or everyone's, at their next step. */
  private stop(agent?: string, meetingID?: string): void {
    const sessions = meetingID ? this.model.busySessionsOfMeeting(meetingID) : this.model.busySessions(agent)
    if (!sessions.length) return
    if (this.demo.active) {
      this.demo.abort(sessions.map((s) => s.sessionID))
      return
    }
    const roots = new Set(sessions.map((s) => this.model.rootSessionOf(s.sessionID)))
    for (const root of roots) this.stops.set(root, Date.now())
    this.log(`Stop requested for ${[...roots].join(", ")}: Claude Code stops at its next step`)
    void vscode.window.setStatusBarMessage("Star Office: Claude Code stops at its next step.", 5000)
  }

  private transcriptFile(sid: string): string | undefined {
    const known = this.transcripts.get(sid)
    if (known && fs.existsSync(known)) return known
    const root = this.model.rootSessionOf(sid)
    const rootFile = this.transcripts.get(root)
    if (!rootFile || root === sid) return known
    const found = subagentTranscript(rootFile, root, sid)
    if (found) this.transcripts.set(sid, found)
    return found
  }

  /** Conversation of a character's current session, for the office chat. */
  private transcript(agent: string): { sessionID?: string; messages?: TranscriptMessage[]; error?: string } {
    const char = this.model.getCharacter(agent)
    if (!char?.sessionID) return { messages: [] }
    if (this.demo.active) return { sessionID: char.sessionID, messages: this.demo.transcript(agent, char.sessionTitle) }
    const file = this.transcriptFile(char.sessionID)
    if (!file) return { sessionID: char.sessionID, messages: [] }
    const messages = readTranscript(file).map((m) => ({ ...m, speaker: m.role === "user" ? undefined : agent }))
    return { sessionID: char.sessionID, messages }
  }

  /** Every conversation of a meeting, merged in time order, with who talks to whom. */
  private meetingTranscript(meetingID: string): { sessionID?: string; messages?: TranscriptMessage[]; error?: string } {
    const sessions = this.model.meetingSessions(meetingID)
    if (!sessions.length) return { messages: [] }
    if (this.demo.active) return { sessionID: meetingID, messages: this.demo.meetingTranscript(sessions.map((s) => s.speaker)) }
    const lead = sessions.find((s) => s.sessionID === meetingID)?.speaker ?? MAIN_AGENT
    const merged: TranscriptMessage[] = []
    for (const s of sessions) {
      const file = this.transcriptFile(s.sessionID)
      if (!file) continue
      const isRoot = s.sessionID === meetingID
      for (const m of readTranscript(file)) {
        if (m.role === "assistant") {
          // The brief already shows up as the sub-agent's first message.
          const parts = isRoot ? m.parts.map((p) => (p.type === "subtask" ? { type: "tool" as const, tool: "Task", status: p.status, title: p.tool } : p)) : m.parts
          merged.push({ ...m, id: `${s.sessionID}:${m.id}`, parts, speaker: s.speaker })
        } else if (isRoot) merged.push({ ...m, id: `${s.sessionID}:${m.id}`, speaker: undefined })
        else merged.push({ ...m, id: `${s.sessionID}:${m.id}`, speaker: lead, to: s.speaker })
      }
    }
    merged.sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
    return { sessionID: meetingID, messages: merged }
  }

  /** Talks to a whole meeting through its lead; optionally stops the team first to redirect it. */
  private async meetingPrompt(meetingID: string, text: string, stopFirst: boolean): Promise<PromptResult> {
    const clean = String(text ?? "").trim()
    if (!clean) return { ok: false, error: "Empty message" }
    const root = this.model.meetingSessions(meetingID).find((s) => s.sessionID === meetingID)
    if (!root) return { ok: false, error: "This conversation is not available any more." }
    if (stopFirst) this.stop(undefined, meetingID)
    if (this.demo.active) return this.prompt(root.speaker, clean, false)
    return this.openInClaude(clean, meetingID, root.speaker, clean)
  }

  private async openSession(agent: string): Promise<void> {
    const char = this.model.getCharacter(agent)
    if (!char?.sessionID) return this.openClaude()
    const root = this.model.rootSessionOf(char.sessionID)
    try {
      await vscode.commands.executeCommand("claude-vscode.editor.open", root)
    } catch (err) {
      this.log(`Could not open session ${root} in Claude Code: ${String(err)}`)
      await this.openClaude()
    }
  }

  private async openClaude(): Promise<void> {
    if (!this.claudeInstalled()) {
      const pick = await vscode.window.showInformationMessage("Claude Code is not installed in this VS Code.", "Show Claude Code")
      if (pick) await vscode.commands.executeCommand("workbench.extensions.search", CLAUDE_EXTENSION_ID)
      return
    }
    try {
      await vscode.commands.executeCommand("claude-vscode.editor.openLast")
    } catch {
      await vscode.commands.executeCommand("claude-vscode.sidebar.open")
    }
  }

  // ---------- profiles and briefing ----------
  private loadProfile(target: ProfileTarget): { profile?: ReturnType<typeof readProfile>; error?: string } {
    if (!validTarget(target)) return { error: "Unknown profile" }
    try {
      return { profile: readProfile(profilesFile(starHome()), target) }
    } catch (err) {
      return { error: String(err) }
    }
  }

  private saveProfile(target: ProfileTarget, context: unknown, folders: unknown): { ok: boolean; error?: string; reloadNeeded?: boolean } {
    if (!validTarget(target)) return { ok: false, error: "Unknown profile" }
    const list = (Array.isArray(folders) ? folders : [])
      .filter((f): f is { path: string; note?: string } => !!f && typeof f.path === "string")
      .map((f) => ({ path: f.path, note: typeof f.note === "string" ? f.note : undefined }))
    try {
      saveProfile(profilesFile(starHome()), target, { context: String(context ?? ""), folders: list })
      if (target.kind === "team") this.syncTeamFolders()
      this.log(`Saved the ${target.kind === "team" ? "team" : target.name} profile`)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }

  /** The team's linked folders become Claude Code working directories (permissions.additionalDirectories). */
  private syncTeamFolders(): void {
    const record = path.join(starHome(), "additional-directories.json")
    let previous: string[] = []
    try {
      previous = JSON.parse(fs.readFileSync(record, "utf8"))
    } catch {}
    const folders = readProfile(profilesFile(starHome()), { kind: "team" }).folders.map((f) => f.path)
    try {
      if (syncAdditionalDirectories(this.settingsFile(), folders, Array.isArray(previous) ? previous : [])) {
        this.log(`Claude Code working directories: ${folders.join(", ") || "none from Star UI"}`)
      }
      fs.mkdirSync(path.dirname(record), { recursive: true })
      fs.writeFileSync(record, JSON.stringify(folders) + "\n", { mode: 0o600 })
    } catch (err) {
      this.log(`Could not update Claude Code's working directories: ${String(err)}`)
    }
  }

  /** What an agent is told when it starts. Empty when there is nothing to tell (no team, no profile). */
  private briefingFor(agent: string, onlyIfUseful = false): string {
    const file = profilesFile(starHome())
    const input = {
      agent,
      mainAgent: MAIN_AGENT,
      roster: this.agents,
      team: readProfile(file, { kind: "team" }),
      own: readProfile(file, { kind: "agent", name: agent }),
    }
    if (onlyIfUseful && !hasBriefing(input)) return ""
    return briefing(input)
  }

  // ---------- connect ----------
  private async connect(): Promise<void> {
    const file = this.settingsFile()
    try {
      this.copyHookScript()
      installHooks(file, this.expectedHooks())
      this.syncTeamFolders()
      this.log(`Installed the Claude Code hooks in ${file}`)
      this.scheduleBroadcast()
      const pick = await vscode.window.showInformationMessage(
        `Star Office is connected: hooks were added to ${file}. New Claude Code conversations report to the office (restart the ones already open).`,
        "Open the office",
      )
      if (pick) this.openPanel()
    } catch (err) {
      void vscode.window.showErrorMessage(`Star UI for Claude Code: could not install the hooks (${err instanceof Error ? err.message : String(err)}).`)
    }
  }

  private async disconnect(): Promise<void> {
    let removed = false
    try {
      removed = uninstallHooks(this.settingsFile())
    } catch (err) {
      void vscode.window.showErrorMessage(`Star UI for Claude Code: could not remove the hooks (${err instanceof Error ? err.message : String(err)}).`)
      return
    }
    this.log(removed ? `Removed the hooks from ${this.settingsFile()}` : "The hooks were not installed")
    this.scheduleBroadcast()
    void vscode.window.showInformationMessage(
      removed ? "Star Office is disconnected: its hooks were removed from Claude Code's settings." : "Star Office's hooks were not installed.",
    )
  }

  private async maybeOfferConnect(): Promise<void> {
    if (hooksInstalled(this.settingsFile()) || this.context.globalState.get("connectOffered")) return
    if (!this.connection().claudeDetected) return
    await this.context.globalState.update("connectOffered", true)
    const pick = await vscode.window.showInformationMessage(
      "Star UI for Claude Code: connect the pixel office to Claude Code? This adds hooks to Claude Code's settings.json.",
      "Connect",
      "Try the demo",
      "Not now",
    )
    if (pick === "Connect") await this.connect()
    if (pick === "Try the demo") {
      if (!this.demo.active) this.toggleDemo()
      this.openPanel()
    }
  }

  private toggleDemo(): void {
    if (this.demo.active) {
      this.demo.stop()
      this.model.clear()
      this.rosterKey = ""
      this.refreshRoster()
    } else {
      this.model.clear()
      this.demo.start()
    }
    this.scheduleBroadcast()
  }

  // ---------- team ----------
  private async createTeam(): Promise<void> {
    const preset = await vscode.window.showQuickPick(
      TEAM_PRESETS.map((p) => ({ label: p.label, detail: p.detail, preset: p })),
      { title: "Create a virtual team of Claude Code sub-agents", placeHolder: "Pick a kind of team" },
    )
    if (!preset) return
    const roles = preset.preset.roles.map((id) => ROLE_TEMPLATES.find((r) => r.id === id)).filter((r) => !!r)
    const picks = await vscode.window.showQuickPick(
      roles.map((r) => ({ label: r.label, description: r.id, detail: r.description, picked: preset.preset.selected.includes(r.id), role: r })),
      { canPickMany: true, title: `${preset.preset.label}: team members`, placeHolder: "Pick the team members" },
    )
    if (!picks?.length) return
    const folders = vscode.workspace.workspaceFolders ?? []
    const targets: { label: string; description: string; dir: string }[] = folders.map((f) => ({
      label: `Project: ${f.name}`,
      description: ".claude/agents/ (can be committed and shared)",
      dir: path.join(f.uri.fsPath, ".claude", "agents"),
    }))
    targets.push({ label: "Global", description: "~/.claude/agents/ (all your projects)", dir: path.join(this.configDir(), "agents") })
    const target = targets.length === 1 ? targets[0] : await vscode.window.showQuickPick(targets, { title: "Where should the team live?" })
    if (!target) return
    try {
      const { created, skipped } = writeRoles(
        target.dir,
        picks.map((p) => p.role),
      )
      this.log(`Team written to ${target.dir}: created ${created.join(", ") || "none"}, kept ${skipped.join(", ") || "none"}`)
      this.refreshRoster()
      const pick = await vscode.window.showInformationMessage(
        `Team ready in ${target.dir}` +
          (created.length ? ` (new: ${created.join(", ")})` : "") +
          (skipped.length ? ` (already there: ${skipped.join(", ")})` : "") +
          ". Claude Code meets them in new conversations.",
        "Open folder",
      )
      if (pick === "Open folder") await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(target.dir))
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not create the team: ${String(err)}`)
    }
  }

  // ---------- misc ----------
  private cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(CONFIG)
  }

  private log(line: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${line}`)
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}
