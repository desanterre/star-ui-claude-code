import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, it } from "node:test"
import { ROLE_TEMPLATES, TEAM_PRESETS, colorOf, namedColor, renderAgent, writeRoles } from "../src/team"
import { renderOfficeHtml } from "../src/webview"

describe("team templates", () => {
  it("renders Claude Code sub-agent files", () => {
    const md = renderAgent(ROLE_TEMPLATES.find((r) => r.id === "reviewer")!)
    assert.match(md, /^---\nname: reviewer\ndescription: .+\ntools: Read, Grep, Glob, WebFetch, WebSearch\ncolor: yellow\n---\n\nYou are/)
    const dev = renderAgent(ROLE_TEMPLATES.find((r) => r.id === "developer")!)
    assert.ok(!dev.includes("\ntools:"), "roles that change code keep every tool")
  })

  it("maps office colors to Claude Code's named colors and back", () => {
    assert.equal(namedColor("#3b82f6"), "blue")
    assert.equal(namedColor("#a78bfa"), "purple")
    assert.equal(colorOf("green"), "#22c55e")
    assert.equal(colorOf("#123456"), "#123456")
    assert.equal(colorOf("chartreuse"), undefined)
  })

  it("offers presets whose roles all exist", () => {
    for (const preset of TEAM_PRESETS) {
      for (const id of preset.roles) assert.ok(ROLE_TEMPLATES.find((r) => r.id === id), `${preset.id}: ${id}`)
      for (const id of preset.selected) assert.ok(preset.roles.includes(id), `${preset.id}: ${id} selected but not offered`)
    }
    const ids = ROLE_TEMPLATES.map((r) => r.id)
    assert.equal(new Set(ids).size, ids.length, "role ids are unique")
    assert.ok(!ids.includes("manager"), "the main conversation leads the team")
  })

  it("gives every teammate the shared report format", () => {
    for (const role of ROLE_TEMPLATES) assert.match(role.prompt, /## Report back/, role.id)
  })

  it("never overwrites an existing agent file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "star-team-"))
    fs.writeFileSync(path.join(dir, "reviewer.md"), "mine")
    const roles = ["architect", "developer", "reviewer"].map((id) => ROLE_TEMPLATES.find((r) => r.id === id)!)
    const { created, skipped } = writeRoles(dir, roles)
    assert.deepEqual(created, ["architect", "developer"])
    assert.deepEqual(skipped, ["reviewer"])
    assert.equal(fs.readFileSync(path.join(dir, "reviewer.md"), "utf8"), "mine")
  })
})

describe("webview html", () => {
  it("locks scripts to a nonce and escapes boot data", () => {
    const html = renderOfficeHtml({
      mediaUri: "https://example/media/",
      cspSource: "https://example",
      language: "fr",
      officeName: "</script><script>alert(1)</script>",
      room: "office",
    })
    const nonce = html.match(/'nonce-([^']+)'/)![1]
    assert.equal((html.match(new RegExp(`nonce="${nonce.replace(/[+/=]/g, "\\$&")}"`, "g")) || []).length, 4)
    assert.ok(!html.includes("</script><script>alert(1)"))
    assert.match(html, /<html lang="fr">/)
    assert.match(html, /src="https:\/\/example\/media\/office\.js"/)
  })
})
