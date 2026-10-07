import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as http from "node:http"
import * as path from "node:path"
import type { HookPayload, HookReply } from "./protocol"

const MAX_BODY = 1024 * 1024

/**
 * Local HTTP endpoint the Claude Code hook talks to.
 * Listens on 127.0.0.1 only, on a random port, and requires a random bearer token.
 * Port and token are published in <home>/bridges/<pid>-<id>.json (mode 0600) for the hook.
 */
export class Bridge {
  readonly token = crypto.randomBytes(24).toString("hex")
  port = 0
  private server?: http.Server
  private file?: string

  constructor(
    private readonly home: string,
    /** Called for every hook event; what it returns is printed back to Claude Code. */
    private readonly onHook: (payload: HookPayload) => HookReply | undefined | Promise<HookReply | undefined>,
    private readonly version = "0",
  ) {}

  get registryFile(): string | undefined {
    return this.file
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => this.handle(req, res))
    server.keepAliveTimeout = 5_000
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolve())
    })
    this.server = server
    this.port = (server.address() as { port: number }).port
    const dir = path.join(this.home, "bridges")
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.file = path.join(dir, `${process.pid}-${crypto.randomBytes(4).toString("hex")}.json`)
    fs.writeFileSync(
      this.file,
      JSON.stringify({ port: this.port, token: this.token, pid: process.pid, version: this.version }),
      { mode: 0o600 },
    )
    this.cleanupStale(dir)
  }

  dispose(): void {
    this.server?.close()
    this.server = undefined
    if (this.file) {
      try {
        fs.unlinkSync(this.file)
      } catch {}
    }
  }

  private authorized(req: http.IncomingMessage): boolean {
    // Browsers always send Origin on cross-site requests; the hook never does.
    if (req.headers.origin) return false
    const header = req.headers.authorization ?? ""
    const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "")
    const expected = Buffer.from(this.token)
    return given.length === expected.length && crypto.timingSafeEqual(given, expected)
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.authorized(req)) return json(res, 401, { error: "unauthorized" })
    const url = new URL(req.url ?? "/", "http://127.0.0.1")

    if (req.method === "GET" && url.pathname === "/v1/health") return json(res, 200, { ok: true, name: "star-ui-claude-code" })

    if (req.method === "POST" && url.pathname === "/v1/hook") {
      readJson(req)
        .then(async (body) => {
          const payload = body as HookPayload
          if (!payload || typeof payload.input !== "object" || !payload.input || typeof payload.input.hook_event_name !== "string") {
            return json(res, 400, { error: "bad request" })
          }
          let reply: HookReply | undefined
          try {
            reply = await this.onHook(payload)
          } catch {
            reply = undefined
          }
          json(res, 200, { reply: reply ?? null })
        })
        .catch(() => json(res, 400, { error: "bad request" }))
      return
    }

    json(res, 404, { error: "not found" })
  }

  /** Removes registry files left behind by crashed VS Code windows. */
  private cleanupStale(dir: string): void {
    try {
      for (const name of fs.readdirSync(dir)) {
        const pid = Number(name.split("-")[0])
        if (!pid || pid === process.pid) continue
        try {
          process.kill(pid, 0)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ESRCH") fs.rmSync(path.join(dir, name), { force: true })
        }
      }
    } catch {}
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
  res.end(JSON.stringify(body))
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error("payload too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch (err) {
        reject(err)
      }
    })
    req.on("error", reject)
  })
}
