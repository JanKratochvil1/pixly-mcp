#!/usr/bin/env node
/**
 * pixly — Pixly from the command line (and for AI coding agents).
 *
 * A thin client for Pixly's MCP endpoint (https://pixly.app/api/mcp): pass a
 * photo URL or a local file (uploaded via a presigned ticket), tools run
 * server-side against your Pixly account, results download back to disk. Auth is an API key from
 * https://pixly.app/app/settings in the PIXLY_API_KEY env var.
 *
 * Zero dependencies; Node >= 18 (native fetch).
 */

import { readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { basename, extname } from "node:path"
import process from "node:process"

const MCP_URL = process.env.PIXLY_MCP_URL || "https://pixly.app/api/mcp"
const API_KEY = process.env.PIXLY_API_KEY || ""

const IMAGE_POLL_MS = 2000
const IMAGE_POLL_MAX = 60 // ~2 min — image tools normally return completed inline
const VIDEO_POLL_MS = 5000
const VIDEO_POLL_MAX = 120 // ~10 min

const CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
}

// ── Small helpers ────────────────────────────────────────────────────────────

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true
      } else {
        flags[key] = next
        i++
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

let rpcId = 0
async function rpc(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  })
  if (res.status === 401) {
    fail("invalid or missing API key. Create one at https://pixly.app/app/settings and set PIXLY_API_KEY.")
  }
  const json = await res.json().catch(() => null)
  if (!json) fail(`unexpected response from ${MCP_URL} (HTTP ${res.status})`)
  if (json.error) fail(`${json.error.message ?? "server error"}`)
  return json.result
}

/** tools/call → parsed JSON payload (or exit on tool error). */
async function callTool(name, args) {
  const result = await rpc("tools/call", { name, arguments: args })
  const text = result?.content?.[0]?.text ?? ""
  if (result?.isError) fail(text || `${name} failed`)
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

/**
 * Photo argument → the source fields a tool takes, as an object to spread.
 *
 * A URL goes straight through as imageUrl — the server fetches it. Only local
 * bytes need an upload ticket. `prefix` covers the two-frame reel tool, whose
 * fields are beforeImageUrl/beforeR2Path rather than imageUrl/r2Path.
 */
async function resolvePhoto(input, prefix = "") {
  const field = (base) => (prefix ? `${prefix}${base[0].toUpperCase()}${base.slice(1)}` : base)
  if (!input) fail("missing photo argument")
  if (/^https?:\/\//i.test(input)) return { [field("imageUrl")]: input }
  if (input.startsWith("users/")) return { [field("r2Path")]: input } // already an r2Path
  if (!existsSync(input)) fail(`not a file or URL: ${input}`)
  const contentType = CONTENT_TYPES[extname(input).toLowerCase()]
  if (!contentType) fail(`unsupported file type: ${input} (use jpg, png, or webp)`)
  const bytes = await readFile(input)
  // Send the exact size: the server signs it into the presigned URL, so the
  // upload is bounded by R2 itself rather than by our good behaviour. The
  // server still accepts tickets without it, for older clients.
  const ticket = await callTool("create_upload_ticket", {
    filename: basename(input),
    contentType,
    sizeBytes: bytes.byteLength,
  })
  const put = await fetch(ticket.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType, "Content-Length": String(bytes.byteLength) },
    body: bytes,
  })
  if (!put.ok) {
    fail(
      put.status === 413 || put.status === 400
        ? `upload rejected (HTTP ${put.status}) — the file may be over the 10 MB limit`
        : `upload failed (HTTP ${put.status})`,
    )
  }
  console.error(`uploaded ${input} → ${ticket.r2Path}`)
  return { [field("r2Path")]: ticket.r2Path }
}

async function pollJob(jobId, { video = false } = {}) {
  const max = video ? VIDEO_POLL_MAX : IMAGE_POLL_MAX
  const interval = video ? VIDEO_POLL_MS : IMAGE_POLL_MS
  for (let i = 0; i < max; i++) {
    const job = await callTool("get_job", { jobId })
    if (job.status === "completed") return job
    if (job.status === "failed") {
      fail(`generation failed${job.error ? `: ${job.error}` : ""} (credits enter refund review)`)
    }
    if (i === 0) console.error(`waiting for job ${jobId}…`)
    await new Promise((r) => setTimeout(r, interval))
  }
  fail(`timed out waiting for job ${jobId} — check later with: pixly job ${jobId}`)
}

async function download(urls, outFlag, defaultBase, ext) {
  const saved = []
  for (let i = 0; i < urls.length; i++) {
    const name =
      urls.length === 1
        ? outFlag || `${defaultBase}${ext}`
        : outFlag
          ? outFlag.replace(new RegExp(`${ext.replace(".", "\\.")}$`), `-${i + 1}${ext}`)
          : `${defaultBase}-${i + 1}${ext}`
    const res = await fetch(urls[i])
    if (!res.ok) fail(`download failed (HTTP ${res.status})`)
    await writeFile(name, Buffer.from(await res.arrayBuffer()))
    saved.push(name)
  }
  return saved
}

/** Shared run: submit → poll → download. */
async function runAndSave(toolName, args, { video = false, out, base }) {
  const submitted = await callTool(toolName, args)
  const jobId = submitted.jobId
  if (!jobId) fail(`no jobId in response: ${JSON.stringify(submitted)}`)
  console.error(`job ${jobId} · ${submitted.creditsCharged ?? "?"} credit(s)`)
  const job = submitted.status === "completed" ? submitted : await pollJob(jobId, { video })
  const urls = job.resultUrls ?? []
  if (urls.length === 0) fail(`job ${jobId} completed but returned no result URLs`)
  const saved = await download(urls, out, base, video ? ".mp4" : ".jpg")
  for (const f of saved) console.log(f)
}

const baseFrom = (input, suffix) =>
  `${basename(input, extname(input)).replace(/^users\/.*\//, "")}-${suffix}`

// ── Commands ─────────────────────────────────────────────────────────────────

const commands = {
  async stage({ positional, flags }) {
    const photo = await resolvePhoto(positional[0])
    if (!flags.style) fail("--style is required (e.g. --style scandinavian)")
    // Staging renders one image per job server-side. --variations shipped in
    // 0.1.0 and is still accepted so old scripts don't die, but say plainly
    // that it does nothing rather than silently returning one image.
    if (flags.variations) {
      console.error("note: --variations is ignored — staging returns one image per call. Run it again for another take.")
    }
    await runAndSave(
      "virtual_staging",
      {
        ...photo,
        style: String(flags.style),
        ...(flags.room ? { roomType: String(flags.room) } : {}),
        ...(flags.instructions ? { customInstructions: String(flags.instructions) } : {}),
        ...(flags.pro ? { stagingQuality: "pro" } : {}),
      },
      { out: flags.out, base: baseFrom(positional[0], "staged") },
    )
  },

  async enhance({ positional, flags }) {
    const photo = await resolvePhoto(positional[0])
    await runAndSave("enhance_photo", photo, { out: flags.out, base: baseFrom(positional[0], "enhanced") })
  },

  async declutter({ positional, flags }) {
    const photo = await resolvePhoto(positional[0])
    await runAndSave("declutter_photo", photo, { out: flags.out, base: baseFrom(positional[0], "decluttered") })
  },

  async "day-to-night"({ positional, flags }) {
    const photo = await resolvePhoto(positional[0])
    await runAndSave("day_to_night", photo, { out: flags.out, base: baseFrom(positional[0], "night") })
  },

  async "plot-sign"({ positional, flags }) {
    const photo = await resolvePhoto(positional[0])
    if (!flags.text) fail('--text is required (e.g. --text "SOLD")')
    await runAndSave(
      "plot_sign",
      {
        ...photo,
        text: String(flags.text),
        ...(flags.look ? { look: String(flags.look) } : {}),
        ...(flags.orientation ? { orientation: String(flags.orientation) } : {}),
      },
      { out: flags.out, base: baseFrom(positional[0], "sign") },
    )
  },

  async motion({ positional, flags }) {
    const photo = await resolvePhoto(positional[0])
    await runAndSave(
      "cinematic_motion",
      {
        ...photo,
        cameraMove: String(flags.move ?? "zoom"),
        durationSeconds: flags.duration ? Number(flags.duration) : 5,
        format: String(flags.format ?? "9:16"),
      },
      { video: true, out: flags.out, base: baseFrom(positional[0], "motion") },
    )
  },

  async reel({ flags }) {
    if (!flags.before || !flags.after) fail("--before and --after are required")
    const before = await resolvePhoto(String(flags.before), "before")
    const after = await resolvePhoto(String(flags.after), "after")
    await runAndSave(
      "before_after_reel",
      {
        ...before,
        ...after,
        videoIntent: String(flags.intent ?? "staging_reveal"),
        revealStyle: String(flags.reveal ?? "smooth"),
        durationSeconds: flags.duration ? Number(flags.duration) : 5,
        format: String(flags.format ?? "9:16"),
      },
      { video: true, out: flags.out, base: "reel" },
    )
  },

  async job({ positional }) {
    if (!positional[0]) fail("usage: pixly job <jobId>")
    console.log(JSON.stringify(await callTool("get_job", { jobId: positional[0] }), null, 2))
  },

  async jobs({ flags }) {
    const result = await callTool("list_library", {
      limit: flags.limit ? Number(flags.limit) : 20,
      ...(flags.type ? { type: String(flags.type) } : {}),
    })
    for (const j of result.jobs ?? []) {
      console.log(`${j.jobId}  ${String(j.type).padEnd(14)} ${String(j.status).padEnd(11)} ${j.createdAt}`)
    }
  },

  async balance() {
    const b = await callTool("get_credit_balance", {})
    console.log(`${b.creditsRemaining} credits · ${b.plan}`)
  },

  async tools() {
    const result = await rpc("tools/list", {})
    for (const tool of result.tools ?? []) {
      console.log(`${tool.name.padEnd(22)} ${tool.description.split(". ")[0]}.`)
    }
  },
}

const HELP = `pixly — Pixly for the command line · https://pixly.app/mcp

Setup:
  export PIXLY_API_KEY=pixly_sk_...   # create at https://pixly.app/app/settings

Photos (pass a URL or a local file — local files upload automatically):
  pixly stage <photo> --style <id> [--room <type>] [--pro] [--out file.jpg]
  pixly enhance <photo> [--out file.jpg]
  pixly declutter <photo> [--out file.jpg]
  pixly day-to-night <photo> [--out file.jpg]
  pixly plot-sign <photo> --text "SOLD" [--look stone|metal|grass|sign] [--out file.jpg]

Videos:
  pixly motion <photo> [--move zoom|orbit|crane-up|...] [--duration 5|10] [--format 9:16|16:9] [--out file.mp4]
  pixly reel --before a.jpg --after b.jpg [--reveal smooth|slideIn|dropLand|glowBuild|movers] [--out file.mp4]

Account:
  pixly balance            credits remaining
  pixly jobs [--limit 20] [--type images|videos]
  pixly job <jobId>        status + result URLs
  pixly tools              list every available tool
`

// ── Entry ────────────────────────────────────────────────────────────────────

const [, , command, ...rest] = process.argv
if (!command || command === "help" || command === "--help" || command === "-h") {
  console.log(HELP)
  process.exit(0)
}
if (!commands[command]) fail(`unknown command "${command}" — run: pixly help`)
if (!API_KEY) fail("PIXLY_API_KEY is not set. Create a key at https://pixly.app/app/settings.")

commands[command](parseArgs(rest)).catch((err) => fail(err instanceof Error ? err.message : String(err)))
