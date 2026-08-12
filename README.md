# Pixly MCP

[Pixly](https://pixly.app) gives AI assistants real-estate visual tools: virtual
staging, listing-photo enhancement, decluttering, day-to-night, plot signs, and
cinematic property video — HD and watermark-free.

Connector → **`https://pixly.app/api/mcp`** · Setup & docs → [pixly.app/mcp](https://pixly.app/mcp)

Generations spend your normal Pixly credit balance — same pipeline, quality and
pricing as the app, and every result also lands in your Pixly Library. There is
no separate API plan to buy.

## Tools

| Tool | Description |
| --- | --- |
| `virtual_staging` | Furnish and style an empty (or badly furnished) room photo in a chosen interior style |
| `edit_staged_photo` | Apply a specific change to a staged photo (swap the sofa, add a rug) while preserving the rest |
| `enhance_photo` | Turn an amateur listing photo into a finished professional one — returns 3 variants |
| `declutter_photo` | Remove clutter and personal items while keeping the room and architecture intact |
| `day_to_night` | Turn a daytime exterior into a magazine-style dusk scene, building and angle unchanged |
| `plot_sign` | Place a photorealistic 3D monument sign with your text onto a photo of an empty plot |
| `cinematic_motion` | Turn one listing photo into a short clip with a real camera move (orbit, fly-through, crane…) |
| `before_after_reel` | Animate a before→after transformation into a social-ready reveal video |
| `create_upload_ticket` · `upload_image_from_url` | Get photos in |
| `get_job` · `list_library` · `get_credit_balance` | Poll jobs, browse results, check credits |

Tools compose. One prompt can declutter the lived-in rooms, stage the empty
ones, and cut the reveal reel from the result.

## Connect

### Claude, ChatGPT — no API key

Add `https://pixly.app/api/mcp` as a custom connector and sign in with your
Pixly account. Claude: Settings → Connectors → Add custom connector. ChatGPT:
Settings → Connectors → Advanced → Developer mode.

### Claude Code, Cursor — API key

Create a key at [pixly.app/app/settings](https://pixly.app/app/settings), then:

```bash
claude mcp add -s user --transport http pixly https://pixly.app/api/mcp \
  --header "Authorization: Bearer $PIXLY_API_KEY"
```

Cursor and Windsurf take the same endpoint in their MCP config, with an
`Authorization: Bearer` header.

### Clients that only speak stdio

Pixly's server is remote (streamable HTTP). If your client cannot reach a
remote server, bridge it with the community
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```bash
npx mcp-remote https://pixly.app/api/mcp
```

## CLI

The `pixly` command in this repo is a thin MCP client for the same endpoint —
useful for scripts, CI, and coding agents that would rather run a command than
hold an MCP connection.

```bash
npm install -g pixly-cli
export PIXLY_API_KEY=pixly_sk_...
```

```bash
# Stage an empty room (a URL or a local file — local files upload automatically)
pixly stage living-room.jpg --style scandinavian

# One-click photo tools
pixly enhance photo.jpg
pixly declutter photo.jpg --out clean.jpg
pixly day-to-night exterior.jpg
pixly plot-sign lot.jpg --text "SOLD" --look stone

# Videos
pixly motion photo.jpg --move orbit --duration 5
pixly reel --before empty.jpg --after staged.jpg --reveal smooth

# Account
pixly balance
pixly jobs
pixly tools
pixly help
```

Results are written to the current directory (or `--out <file>`). Tools that
return several images (enhance gives you 3 to pick from) get `-1`, `-2`, …
suffixes.

| Env var | Default | Description |
| --- | --- | --- |
| `PIXLY_API_KEY` | — | Your API key, from Settings. Required. |
| `PIXLY_MCP_URL` | `https://pixly.app/api/mcp` | Endpoint override. |

## Note on scope

This repository holds the connector manifest (`server.json`) and the CLI. The
MCP server itself is remote — it runs inside the Pixly application and is not
open source. Tool schemas are generated from a single registry in that
application and served over `tools/list`, which is why the CLI never hardcodes
them: run `pixly tools` and you get whatever the endpoint currently offers.

## Links

- [Connector setup](https://pixly.app/mcp)
- [Developer docs — REST API, MCP, CLI](https://pixly.app/docs)
- [Machine-readable docs](https://pixly.app/docs.md)
- [Pixly](https://pixly.app)

## License

MIT
