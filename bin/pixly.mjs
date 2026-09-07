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

// Keep in step with the server's allowlist (lib/storage/upload-guard.ts).
// HEIC matters most: it is what an iPhone shoots by default, so it is the
// likeliest file anyone points this at. The server transcodes non-web formats
// to JPEG before any model sees them, so all of these work end to end.
const CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
}

/** Server-side cap for images. Checked here too, to fail before the upload. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

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
      // Omitted entirely when there is no key, rather than sent as an empty
      // bearer: discovery (tools/list) is public, and "Bearer " reads as a
      // malformed credential rather than as no credential.
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
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
  if (!contentType) {
    fail(
      `unsupported file type: ${input}\n` +
        `  supported: ${Object.keys(CONTENT_TYPES).map((e) => e.slice(1)).join(", ")}`,
    )
  }
  const bytes = await readFile(input)
  // Check the size before uploading rather than after. The server signs the
  // length into the presigned URL, so an oversized file fails at R2 with a
  // bare 403 that says nothing useful — this says which file and how big.
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    fail(
      `${input} is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB — the limit is ` +
        `${MAX_IMAGE_BYTES / 1024 / 1024} MB. Nothing was uploaded and no credits were used.`,
    )
  }
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

/**
 * One-line summary of a tool description for `pixly tools`.
 *
 * Splitting on the first ". " looked right and wasn't: it cut
 * before_after_reel at "(e.g." and left get_credit_balance with two full
 * stops, because abbreviations and a trailing period are both just ". ".
 * Clamping on width instead has no such edge cases — and the credits sentence
 * is dropped first, since it is identical on every generation tool and says
 * nothing that distinguishes them.
 */
function summarize(description, width = 96) {
  const text = description.replace(/\s*Costs credits from the user's Pixly balance\.\s*$/, "").trim()
  if (text.length <= width) return text
  const clipped = text.slice(0, width)
  // Prefer a word boundary, but only if one is reasonably near the end.
  const space = clipped.lastIndexOf(" ")
  return `${(space > width * 0.6 ? clipped.slice(0, space) : clipped).replace(/[,;:.\s]+$/, "")}…`
}

/**
 * Print an uploads listing. The r2Path is the useful column, not decoration:
 * it is what you paste back as the photo argument for any command.
 */
function printUploads(result) {
  for (const u of result.uploads ?? []) {
    // KB under a megabyte: a 27 KB thumbnail rendered as "0.0MB" tells you
    // nothing, and listing photos span three orders of magnitude.
    const size = (
      u.sizeBytes >= 1024 * 1024
        ? `${(u.sizeBytes / 1024 / 1024).toFixed(1)}MB`
        : `${Math.max(1, Math.round(u.sizeBytes / 1024))}KB`
    ).padStart(7)
    console.log(`${(u.uploadedAt ?? "").slice(0, 19)}  ${size}  ${u.filename}`)
    console.log(`  ${u.r2Path}`)
  }
  // Surfaces "N files are unusable" and the empty-account hint, both of which
  // explain an otherwise puzzling short or empty list.
  if (result.note) console.error(result.note)
}

const baseFrom = (input, suffix) =>
  `${basename(input, extname(input)).replace(/^users\/.*\//, "")}-${suffix}`

/** "light-clouds" on the command line is "light_clouds" in the schema. */
const id = (v) => String(v).trim().toLowerCase().replace(/-/g, "_")

/**
 * Exterior touch-up scope. The four fixes are named the way the app names
 * them (the schema says "hardscape" where a person says "driveway").
 * `--only` is an allowlist, `--skip` a denylist; without either the tool
 * fixes everything it finds, so nothing is sent at all.
 */
const TOUCHUP_FIXES = { sky: "sky", lawn: "lawn", driveway: "hardscape", hardscape: "hardscape", clutter: "clutter" }
function touchupScope(flags) {
  const parse = (v) =>
    String(v)
      .split(",")
      .map((f) => f.trim().toLowerCase())
      .filter(Boolean)
      .map((f) => {
        if (!TOUCHUP_FIXES[f]) fail(`unknown fix "${f}" — use sky, lawn, driveway or clutter`)
        return TOUCHUP_FIXES[f]
      })
  if (flags.only && flags.skip) fail("use --only or --skip, not both")
  if (flags.only) return { fix: [...new Set(parse(flags.only))] }
  if (flags.skip) {
    const skip = new Set(parse(flags.skip))
    const fix = ["sky", "lawn", "hardscape", "clutter"].filter((f) => !skip.has(f))
    if (fix.length === 0) fail("--skip removed every fix — nothing would change")
    return { fix }
  }
  return {}
}

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

  async "remove-furniture"({ positional, flags }) {
    const photo = await resolvePhoto(positional[0])
    await runAndSave("remove_furniture", photo, { out: flags.out, base: baseFrom(positional[0], "empty") })
  },

  async sky({ positional, flags }) {
    // Flags are checked before the photo is resolved, so a typo fails before
    // a local file is uploaded. --sun-at "0.7,0.2" places the sun (0..1 from
    // the left and the top) and implies --sun on; the server clamps it into
    // the sky.
    let sunPoint = {}
    if (flags["sun-at"]) {
      const [x, y] = String(flags["sun-at"]).split(",").map(Number)
      if (!Number.isFinite(x) || !Number.isFinite(y)) fail('--sun-at takes "x,y" between 0 and 1, e.g. --sun-at 0.7,0.2')
      sunPoint = { sun: "on", sunX: x, sunY: y }
    }
    const photo = await resolvePhoto(positional[0])
    await runAndSave(
      "replace_sky",
      {
        ...photo,
        ...(flags.sky ? { sky: id(flags.sky) } : {}),
        ...(flags.sun ? { sun: id(flags.sun) } : {}),
        ...sunPoint,
      },
      { out: flags.out, base: baseFrom(positional[0], "sky") },
    )
  },

  async lawn({ positional, flags }) {
    const photo = await resolvePhoto(positional[0])
    await runAndSave(
      "replace_lawn",
      {
        ...photo,
        ...(flags.lawn ? { lawn: id(flags.lawn) } : {}),
        ...(flags.shade ? { shade: id(flags.shade) } : {}),
        ...(flags.stripes ? { stripes: id(flags.stripes) } : {}),
      },
      { out: flags.out, base: baseFrom(positional[0], "lawn") },
    )
  },

  async "touch-up"({ positional, flags }) {
    const scope = touchupScope(flags) // before the upload, so a bad flag costs nothing
    const photo = await resolvePhoto(positional[0])
    await runAndSave(
      "touch_up_exterior",
      { ...photo, ...scope },
      { out: flags.out, base: baseFrom(positional[0], "touched-up") },
    )
  },

  async upscale({ positional, flags }) {
    // Free on a Pixly result (an r2Path from `pixly jobs`), 1 credit on a
    // file or URL of your own — the server decides from the path.
    const photo = await resolvePhoto(positional[0])
    await runAndSave("upscale_hd", photo, { out: flags.out, base: baseFrom(positional[0], "hd") })
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
        // Only sent when asked for. Omitting it is not the same as picking a
        // side: each move has its own default wording, and one move (drone
        // orbit) has no default at all, so a flag we invented here would
        // change the shot the server would otherwise render.
        ...(flags.direction ? { direction: String(flags.direction) } : {}),
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
    // `--type uploads` comes back as { uploads } rather than { jobs }. Without
    // this the command printed nothing at all and looked like an empty account.
    if (result.uploads) return printUploads(result)
    for (const j of result.jobs ?? []) {
      console.log(`${j.jobId}  ${String(j.type).padEnd(14)} ${String(j.status).padEnd(11)} ${j.createdAt}`)
    }
  },

  async uploads({ flags }) {
    printUploads(
      await callTool("list_library", {
        type: "uploads",
        limit: flags.limit ? Number(flags.limit) : 20,
      }),
    )
  },

  async balance() {
    const b = await callTool("get_credit_balance", {})
    console.log(`${b.creditsRemaining} credits · ${b.plan}`)
  },

  async tools() {
    const result = await rpc("tools/list", {})
    for (const tool of result.tools ?? []) {
      console.log(`${tool.name.padEnd(22)} ${summarize(tool.description)}`)
    }
  },
}

/** Commands that work with no API key — see the check at the bottom. */
const PUBLIC_COMMANDS = new Set(["tools"])

const HELP = `pixly — Pixly for the command line · https://pixly.app/mcp

Setup:
  export PIXLY_API_KEY=pixly_sk_...   # create at https://pixly.app/app/settings

Photos (pass a URL, a local file, or an r2Path from "pixly uploads"):
  local files upload automatically — jpg, png, webp, heic, heif, tif, tiff
  pixly stage <photo> --style <id> [--room <type>] [--pro] [--out file.jpg]
  pixly enhance <photo> [--out file.jpg]
  pixly declutter <photo> [--out file.jpg]
  pixly remove-furniture <photo> [--out file.jpg]
  pixly day-to-night <photo> [--out file.jpg]
  pixly plot-sign <photo> --text "SOLD" [--look stone|metal|grass|sign] [--out file.jpg]

Exteriors:
  pixly sky <photo> [--sky clear|light-clouds|dramatic-clouds|sunset|pastel-sunrise|winter-clear]
                    [--sun auto|on|off] [--sun-at 0.7,0.2] [--out file.jpg]
  pixly lawn <photo> [--lawn fresh-mown|lush|natural|golf|warm-season] [--shade light|medium|deep]
                     [--stripes auto|on|off] [--out file.jpg]
  pixly touch-up <photo> [--only sky,lawn,driveway,clutter | --skip clutter] [--out file.jpg]
                    sky, lawn, driveway and clutter fixed in one pass, each only where needed

Finish:
  pixly upscale <photo> [--out file.jpg]   2x resolution with real detail, up to 4096 px;
                                           free on a Pixly result, 1 credit on your own photo

Videos:
  pixly motion <photo> [--move zoom|orbit|crane-up|...] [--duration 5|10] [--format 9:16|16:9] [--out file.mp4]
                       [--direction left-to-right|right-to-left]  pan, orbit and drone-orbit only
  pixly reel --before a.jpg --after b.jpg [--reveal smooth|slideIn|dropLand|glowBuild|movers] [--out file.mp4]

Account:
  pixly balance            credits remaining
  pixly jobs [--limit 20] [--type images|videos]
  pixly job <jobId>        status + result URLs
  pixly uploads [--limit]  photos you have uploaded, with their r2Path
  pixly tools              list every available tool (no API key needed)
`

// ── Entry ────────────────────────────────────────────────────────────────────

const [, , command, ...rest] = process.argv
if (!command || command === "help" || command === "--help" || command === "-h") {
  console.log(HELP)
  process.exit(0)
}
if (!commands[command]) fail(`unknown command "${command}" — run: pixly help`)
// `tools` only asks the server what it can do, which needs no credential and
// no account — so someone can see what they would be signing up for before
// they sign up. Everything else touches their library or their credits.
if (!API_KEY && !PUBLIC_COMMANDS.has(command)) {
  fail("PIXLY_API_KEY is not set. Create a key at https://pixly.app/app/settings.")
}

commands[command](parseArgs(rest)).catch((err) => fail(err instanceof Error ? err.message : String(err)))
