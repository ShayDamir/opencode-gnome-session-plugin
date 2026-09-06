/**
 * opencode plugin — prevent GNOME session suspend while opencode is working.
 *
 * While at least one opencode session is busy (i.e. opencode is not idle),
 * this plugin keeps a `gnome-session-inhibit` process alive so GNOME does
 * not suspend the machine (AC lid close, battery, scheduled sleep, ...).
 *
 * Implementation notes:
 * - Every inhibitor process lives for a finite "lease" (default 120s) by
 *   running `sleep <lease>` under gnome-session-inhibit. A timer renews the
 *   process every lease/2 seconds while a session is busy.
 * - When all sessions go idle, renewals stop and the last inhibitor exits
 *   on its own within one lease — so the machine can suspend again even if
 *   opencode crashes or is killed without a clean shutdown.
 * - If the runtime calls the plugin `dispose` hook, the inhibitor is killed
 *   immediately instead.
 *
 * Options (config tuple form only; auto-discovered plugins use defaults):
 *   "plugin": [
 *     ["file:///abs/path/suspend-inhibit.ts", {
 *       "actions": ["suspend"],          // or "suspend,idle" (comma string)
 *       "reason": "my custom reason",
 *       "leaseSeconds": 120
 *     }]
 *   ]
 *
 * Environment overrides:
 *   OPENCODE_SUSPEND_INHIBIT_ACTIONS=suspend,idle
 *   OPENCODE_SUSPEND_INHIBIT_REASON=...
 */
import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"

type Options = {
  /** Inhibit actions, default ["suspend"]. Array or comma-separated string. */
  actions?: string | string[]
  /** Reason shown by `gnome-session-inhibit -l`. */
  reason?: string
  /** Lifetime in seconds of a single inhibitor process, default 120. */
  leaseSeconds?: number
}

const SERVICE = "suspend-inhibit"
const APP_ID = "opencode"
const DEFAULT_ACTIONS = ["suspend"]
const DEFAULT_REASON = "opencode: agent session is active"
const DEFAULT_LEASE_SECONDS = 120

type Level = "info" | "warn" | "error"

function parseActions(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return DEFAULT_ACTIONS
  const list = Array.isArray(raw) ? raw : raw.split(",")
  const out = list.map((item) => item.trim()).filter(Boolean)
  return out.length > 0 ? out : DEFAULT_ACTIONS
}

function asPositiveNumber(raw: unknown, fallback: number): number {
  const n = typeof raw === "string" ? Number(raw) : (raw as number | undefined)
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : fallback
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
  return out
}

type InhibitorJob = {
  proc: Bun.Subprocess
  startedAt: number
  dead: boolean
  intentionalKill: boolean
}

export default async (input: PluginInput, options?: PluginOptions): Promise<Hooks & { dispose?: () => Promise<void> }> => {
  const { client, $ } = input
  const opts = (options ?? {}) as Options

  const actions = parseActions(opts.actions)
  const envReason = process.env.OPENCODE_SUSPEND_INHIBIT_REASON?.trim()
  const reason =
    typeof opts.reason === "string" && opts.reason.trim() !== ""
      ? opts.reason
      : envReason !== undefined && envReason !== ""
        ? envReason
        : DEFAULT_REASON
  const leaseSeconds = asPositiveNumber(opts.leaseSeconds, DEFAULT_LEASE_SECONDS)
  const renewMs = Math.max(5_000, Math.round((leaseSeconds / 2) * 1000))
  const minAgeMs = Math.max(2_000, Math.round((leaseSeconds / 4) * 1000))

  function log(level: Level, message: string) {
    Promise.resolve()
      .then(() => client.app.log({ body: { service: SERVICE, level, message } }))
      .catch(() => {})
  }

  // Detect availability and CLI syntax once at startup.
  if (!Bun.which("gnome-session-inhibit")) {
    log("warn", "gnome-session-inhibit not found in PATH; plugin disabled")
    return {}
  }
  const help = await $`gnome-session-inhibit --help`.quiet().nothrow()
  // Older builds take the command via --command, newer builds take it as a
  // positional argument. Both are covered below.
  const hasCommandOption = help.stdout.toString().includes("--command")
  const args: string[] = ["gnome-session-inhibit", "--app-id", APP_ID, "--reason", reason]
  for (const action of actions) args.push("--inhibit", action)
  if (hasCommandOption) args.push("--command", "sleep", String(leaseSeconds))
  else args.push("sleep", String(leaseSeconds))

  // Session IDs currently busy (status "busy" or "retry").
  const active = new Set<string>()
  let job: InhibitorJob | null = null
  let failures = 0

  function killJob(current: InhibitorJob) {
    current.intentionalKill = true
    current.proc.kill()
  }

  function spawnInhibitor(): InhibitorJob | null {
    let proc: Bun.Subprocess
    try {
      proc = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" })
    } catch (error) {
      log(
        "error",
        `failed to spawn gnome-session-inhibit: ${error instanceof Error ? error.message : String(error)}`,
      )
      return null
    }
    const next: InhibitorJob = { proc, startedAt: Date.now(), dead: false, intentionalKill: false }
    proc.exited
      .then(() => {
        next.dead = true
        // Only an unexpected exit while a session is still busy is a real
        // problem: the renewal timer will respawn. A lease expiring while
        // idle is the intended shutdown path.
        if (next === job && !next.intentionalKill && active.size > 0) {
          failures += 1
          if (failures === 1 || failures % 10 === 0) {
            log(
              "warn",
              `gnome-session-inhibit exited while a session is busy (failure #${failures}); will respawn on the next renewal tick`,
            )
          }
        }
      })
      .catch(() => {})
    // stderr is a ReadableStream because we passed `stderr: "pipe"`.
    if (proc.stderr && typeof proc.stderr !== "number") {
      drain(proc.stderr)
        .then((text) => {
          const trimmed = text.trim()
          if (trimmed) log("warn", `gnome-session-inhibit: ${trimmed.slice(0, 500)}`)
        })
        .catch(() => {})
    }
    return next
  }

  async function ensureInhibitor() {
    if (active.size === 0) return
    if (job && !job.dead) {
      if (Date.now() - job.startedAt < minAgeMs) return
      // Start the replacement before killing the old one so there is never
      // a gap in which the machine could suspend.
      const next = spawnInhibitor()
      if (next) {
        killJob(job)
        job = next
      }
      return
    }
    const next = spawnInhibitor()
    if (next) {
      job = next
      failures = 0
    }
  }

  // Seed with sessions that are already busy (e.g. plugin loaded while a
  // session is running, or server restarted mid-session). The status call is
  // fire-and-forget with a timeout: it must never block startup, but live
  // `session.status` events on the event bridge make up for a missed seed.
  void (async () => {
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("seed timeout")), 3_000).unref(),
      )
      const res = (await Promise.race([client.session.status({}), timeout])) as unknown as {
        data?: Record<string, { type?: string }>
      }
      for (const [sessionID, status] of Object.entries(res?.data ?? {})) {
        if (status?.type === "busy" || status?.type === "retry") active.add(sessionID)
      }
      if (active.size > 0) await ensureInhibitor()
    } catch {
      // server not reachable yet (or timed out); live events will catch up
    }
  })()

  const timer = setInterval(() => {
    void ensureInhibitor()
  }, renewMs)
  const maybeUnref = (timer as { unref?: () => void }).unref
  if (typeof maybeUnref === "function") maybeUnref.call(timer)

  const onEvent = async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
    try {
      const props = (event.properties ?? {}) as Record<string, any>
      const sessionID = props.sessionID
      if (typeof sessionID !== "string" || sessionID === "") return
      if (event.type === "session.status") {
        const status = props.status
        if (status?.type === "idle") active.delete(sessionID)
        else active.add(sessionID) // busy | retry
      } else if (event.type === "session.idle") {
        active.delete(sessionID)
      } else {
        return
      }
      if (active.size > 0) await ensureInhibitor()
    } catch {
      // event hooks must never throw
    }
  }

  const release = async () => {
    clearInterval(timer)
    if (job && !job.dead) killJob(job)
  }

  const hooks: Hooks & { dispose?: () => Promise<void> } = {
    event: onEvent,
    // Present in newer opencode runtimes; older ones simply never call it.
    // In that case the finite lease above still bounds the inhibit lifetime.
    dispose: release,
  }

  log("info", `inhibiting: ${actions.join(", ")} (reason: ${reason}, lease: ${leaseSeconds}s)`)
  return hooks
}
