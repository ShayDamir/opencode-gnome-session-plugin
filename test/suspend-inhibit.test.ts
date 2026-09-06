/**
 * Live smoke test for the suspend-inhibit plugin.
 *
 * Drives the plugin with synthetic session.status events and verifies
 * against the real GNOME session that `gnome-session-inhibit -l` shows
 * (and later hides) our inhibitor.
 *
 * Requirements: a running GNOME session and gnome-session-inhibit on PATH.
 * Run: bun test/suspend-inhibit.test.ts
 */
import plugin from "../suspend-inhibit"

const REASON = "opencode-suspend-inhibit-selftest"
const LEASE_SECONDS = 8

let failures = 0
function check(name: string, cond: boolean, extra?: string) {
  if (cond) console.log(`ok   - ${name}`)
  else {
    failures++
    console.error(`FAIL - ${name}${extra ? `: ${extra}` : ""}`)
  }
}

const logs: string[] = []
const client = {
  app: {
    log: async ({ body }: { body: { message: string } }) => {
      logs.push(body.message)
    },
  },
  session: {
    status: async () => ({ data: {} }),
  },
}

const input = {
  client,
  project: { id: "test" },
  directory: process.cwd(),
  worktree: process.cwd(),
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost:0"),
  $: Bun.$,
} as any

const hooks: any = await plugin(input, { reason: REASON, leaseSeconds: LEASE_SECONDS })
check("plugin returned an event hook", typeof hooks.event === "function")
check("plugin returned a dispose hook", typeof hooks.dispose === "function")

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const hasOurs = async () => {
  const out = await Bun.$`gnome-session-inhibit -l 2>/dev/null`.nothrow()
  return out.stdout.toString().includes(REASON)
}

const emit = (event: any) => hooks.event({ event })

// 1. session goes busy -> inhibitor must appear
await emit({ type: "session.status", properties: { sessionID: "ses_test_1", status: { type: "busy" } } })
await sleep(1500)
check("inhibitor present after busy", await hasOurs())

// 2. a second busy session keeps it alive after the first goes idle
await emit({ type: "session.status", properties: { sessionID: "ses_test_2", status: { type: "busy" } } })
await emit({ type: "session.status", properties: { sessionID: "ses_test_1", status: { type: "idle" } } })
await sleep(1500)
check("inhibitor persists while second session is busy", await hasOurs())

// 3. deprecated session.idle event also clears a session
await emit({ type: "session.status", properties: { sessionID: "ses_test_3", status: { type: "busy" } } })
await emit({ type: "session.idle", properties: { sessionID: "ses_test_3" } })
await sleep(500)

// 4. all sessions idle -> inhibitor must expire on its own within one lease
await emit({ type: "session.status", properties: { sessionID: "ses_test_2", status: { type: "idle" } } })
const deadline = Date.now() + (LEASE_SECONDS + 5) * 1000
let gone = false
while (Date.now() < deadline) {
  await sleep(1000)
  if (!(await hasOurs())) {
    gone = true
    break
  }
}
check("inhibitor gone after idle + lease expiry", gone)

// 5. dispose releases immediately
await emit({ type: "session.status", properties: { sessionID: "ses_test_4", status: { type: "busy" } } })
await sleep(1500)
check("inhibitor present before dispose", await hasOurs())
await hooks.dispose()
await sleep(1000)
check("inhibitor gone right after dispose", !(await hasOurs()))

console.log("--- plugin logs ---")
for (const line of logs) console.log(line)

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log("\nall checks passed")
