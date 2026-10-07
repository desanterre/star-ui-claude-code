// Runs inside the VS Code extension host (see run.mjs).
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vscode = require("vscode")

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await wait(100)
  }
  throw new Error("timed out")
}

exports.run = async function run() {
  const results = []
  const test = async (name, fn) => {
    try {
      await fn()
      results.push(`✔ ${name}`)
    } catch (err) {
      results.push(`✖ ${name}: ${err && err.stack}`)
    }
  }
  const home = process.env.STAR_UI_CLAUDE_HOME
  const claudeConfig = process.env.STAR_TEST_CLAUDE_CONFIG
  const workspace = process.env.STAR_TEST_WORKSPACE
  fs.mkdirSync(path.join(claudeConfig, "agents"), { recursive: true })
  fs.writeFileSync(path.join(claudeConfig, "agents", "architect.md"), "---\nname: architect\ndescription: Designs solutions\ncolor: purple\n---\nYou design.\n")
  await vscode.workspace.getConfiguration("starUiClaude").update("claudeConfigDir", claudeConfig, vscode.ConfigurationTarget.Global)

  await test("activates", async () => {
    const ext = vscode.extensions.getExtension("desanterre.star-ui-claude-code")
    assert.ok(ext, "extension found")
    await ext.activate()
    assert.equal(ext.isActive, true)
  })

  await test("registers its commands", async () => {
    const all = await vscode.commands.getCommands(true)
    for (const id of ["openOffice", "connect", "disconnect", "createTeam", "toggleDemo", "openClaude", "showLog"]) {
      assert.ok(all.includes(`starUiClaude.${id}`), id)
    }
  })

  let bridge
  const hook = async (input) => {
    const res = await fetch(`http://127.0.0.1:${bridge.port}/v1/hook`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ source: { pid: 4242 }, input: { session_id: "S1", cwd: workspace, ...input } }),
    })
    assert.equal(res.status, 200)
    return (await res.json()).reply
  }

  await test("publishes a bridge for the Claude Code hook", async () => {
    const dir = path.join(home, "bridges")
    const file = await until(() => fs.existsSync(dir) && fs.readdirSync(dir).find((f) => f.startsWith(`${process.pid}-`)))
    bridge = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))
    const res = await fetch(`http://127.0.0.1:${bridge.port}/v1/health`, { headers: { authorization: `Bearer ${bridge.token}` } })
    assert.equal(res.status, 200)
  })

  await test("briefs a new session about its team", async () => {
    const reply = await until(async () => {
      const r = await hook({ hook_event_name: "SessionStart", source: "startup" })
      return r && r.hookSpecificOutput ? r : undefined
    })
    assert.match(reply.hookSpecificOutput.additionalContext, /\*\*architect\*\*: Designs solutions/)
  })

  await test("turns hook events from this workspace into the office", async () => {
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "Hello" })
    await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "npm test" } })
    await hook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_use_id: "b1" })
    // Sessions from elsewhere stay out of this window.
    await hook({ hook_event_name: "UserPromptSubmit", session_id: "OTHER", cwd: path.join(path.dirname(workspace), "elsewhere"), prompt: "Not here" })
  })

  await test("opens the office in an editor tab", async () => {
    await vscode.commands.executeCommand("starUiClaude.openOffice")
    await until(() => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label === "Claude Office")))
  })

  await test("the office webview loads its scene without errors", async () => {
    const diag = await until(async () => {
      const d = await vscode.commands.executeCommand("starUiClaude.diagnostics")
      return d.webviewReady > 0 || d.webviewErrors.length ? d : undefined
    }, 20000)
    assert.deepEqual(diag.webviewErrors, [])
    assert.ok(diag.webviewReady > 0)
    assert.equal(diag.snapshot.main && diag.snapshot.main.name, "claude")
    assert.equal(diag.snapshot.main.sessionTitle, "Hello")
    assert.deepEqual(diag.snapshot.main.waiting, { kind: "permission", label: "Bash" })
    assert.ok(diag.snapshot.guests.some((c) => c.name === "architect" && c.color === "#a855f7"))
    assert.ok(![diag.snapshot.main, ...diag.snapshot.guests].some((c) => c && c.sessionTitle === "Not here"))
  })

  await test("the ★ activity bar entry opens the office", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
    await until(() => !vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label === "Claude Office")))
    await vscode.commands.executeCommand("starUiClaude.home.focus")
    await until(() => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label === "Claude Office")))
  })

  await test("opens the office panel view", async () => {
    await vscode.commands.executeCommand("starUiClaude.office.focus")
  })

  await test("toggles the demo", async () => {
    await vscode.commands.executeCommand("starUiClaude.toggleDemo")
    await wait(500)
    await vscode.commands.executeCommand("starUiClaude.toggleDemo")
  })

  await test("adds and removes its hooks in Claude Code's settings.json", async () => {
    const settings = path.join(claudeConfig, "settings.json")
    fs.writeFileSync(settings, JSON.stringify({ model: "opus" }))
    void vscode.commands.executeCommand("starUiClaude.connect") // resolves when the notification is dismissed
    const data = await until(() => {
      try {
        const d = JSON.parse(fs.readFileSync(settings, "utf8"))
        return d.hooks ? d : undefined
      } catch {}
    })
    assert.equal(data.model, "opus")
    const command = data.hooks.PreToolUse[0].hooks[0].command
    assert.ok(command.includes("star-ui-claude-code-hook.cjs") && command.includes("ELECTRON_RUN_AS_NODE=1"), command)
    assert.ok(fs.existsSync(path.join(home, "star-ui-claude-code-hook.cjs")), "hook script copied next to Star UI's data")
    void vscode.commands.executeCommand("starUiClaude.disconnect")
    await until(() => !JSON.parse(fs.readFileSync(settings, "utf8")).hooks)
    assert.deepEqual(JSON.parse(fs.readFileSync(settings, "utf8")), { model: "opus" })
  })

  console.log("\n" + results.join("\n"))
  const failed = results.filter((r) => r.startsWith("✖"))
  if (failed.length) throw new Error(`${failed.length} integration test(s) failed`)
}
