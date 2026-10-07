import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { after, before, describe, it } from "node:test"
import { Bridge } from "../src/bridge"
import type { HookPayload, HookReply } from "../src/protocol"

describe("Bridge", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "star-bridge-"))
  const received: HookPayload[] = []
  let answer: HookReply | undefined
  const bridge = new Bridge(
    home,
    (p) => {
      received.push(p)
      return answer
    },
    "test",
  )
  let base = ""
  const auth = () => ({ authorization: `Bearer ${bridge.token}` })
  const post = (body: unknown) =>
    fetch(`${base}/v1/hook`, { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify(body) })

  before(async () => {
    await bridge.start()
    base = `http://127.0.0.1:${bridge.port}`
  })
  after(() => bridge.dispose())

  it("publishes a private registry file for the hook", () => {
    const file = bridge.registryFile!
    const info = JSON.parse(fs.readFileSync(file, "utf8"))
    assert.equal(info.port, bridge.port)
    assert.equal(info.token, bridge.token)
    assert.equal(info.pid, process.pid)
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  })

  it("rejects requests without the token or coming from a browser", async () => {
    assert.equal((await fetch(`${base}/v1/health`)).status, 401)
    assert.equal((await fetch(`${base}/v1/health`, { headers: { authorization: "Bearer nope" } })).status, 401)
    assert.equal((await fetch(`${base}/v1/health`, { headers: { ...auth(), origin: "https://evil.example" } })).status, 401)
    assert.equal((await fetch(`${base}/v1/health`, { headers: auth() })).status, 200)
  })

  it("hands hook events over and answers with the office's reply", async () => {
    answer = { continue: false, stopReason: "Stopped" }
    const res = await post({ source: { pid: 7 }, input: { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash" } })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { reply: { continue: false, stopReason: "Stopped" } })
    assert.equal(received.at(-1)?.source?.pid, 7)
    assert.equal(received.at(-1)?.input.tool_name, "Bash")

    answer = undefined
    assert.deepEqual(await (await post({ input: { hook_event_name: "Stop", session_id: "s1" } })).json(), { reply: null })
  })

  it("refuses malformed events", async () => {
    assert.equal((await post({ events: [] })).status, 400)
    assert.equal((await post({ input: { session_id: "s1" } })).status, 400)
  })

  it("removes its registry file on dispose", () => {
    const other = new Bridge(home, () => undefined)
    return other.start().then(() => {
      const file = other.registryFile!
      assert.ok(fs.existsSync(file))
      other.dispose()
      assert.ok(!fs.existsSync(file))
    })
  })
})
