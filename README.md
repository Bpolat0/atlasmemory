# AtlasMemory

**Proof-backed, drift-resistant AI memory for your codebase.**

Give your AI agent perfect memory of your entire codebase — with evidence for every claim and drift detection across sessions.

[![npm version](https://img.shields.io/npm/v/atlasmemory)](https://www.npmjs.com/package/atlasmemory)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

## Why AtlasMemory?

Every AI coding tool indexes your codebase. **None of them prove their claims.**

| Feature | Others | AtlasMemory |
|---------|--------|-------------|
| Code indexing | Yes | Yes |
| Semantic search | Yes | Yes |
| **Proof-backed claims** | No | Every claim links to source evidence |
| **Drift detection** | No | Contracts detect repo changes mid-session |
| **One command setup** | No | `npx atlasmemory` — zero config |

## Quickstart (30 seconds)

### With Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "atlasmemory": {
      "command": "npx",
      "args": ["-y", "atlasmemory"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

Restart Claude Desktop. Ask: *"Search my codebase for authentication logic"*

AtlasMemory auto-indexes your project on first query. No setup needed.

### With Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "atlasmemory": {
      "command": "npx",
      "args": ["-y", "atlasmemory"]
    }
  }
}
```

### With VS Code (Copilot)

Add to your VS Code `settings.json`:

```json
{
  "mcp": {
    "servers": {
      "atlasmemory": {
        "command": "npx",
        "args": ["-y", "atlasmemory"]
      }
    }
  }
}
```

### CLI Mode

```bash
npx atlasmemory index .                           # Index your project
npx atlasmemory search "authentication flow"       # Search
npx atlasmemory taskpack "Fix the memory leak"     # Generate context pack
npx atlasmemory bootpack                           # Bootstrap capsule
```

## How It Works

```
Your Codebase
     |
     v
[Tree-sitter Parser] ─── Extracts symbols, imports, call refs
     |
     v
[SQLite Store] ─── FTS5 search, graph edges, anchors
     |
     v
[Card Generator] ─── Evidence-backed summaries (deterministic)
     |
     v
[TaskPack Builder] ─── Token-budgeted context for your AI
     |
     v
[MCP Server] ─── Serves tools to Claude, Cursor, Copilot
     |
     v
[Contract Service] ─── Detects drift, ensures consistency
```

### Three Pillars

**1. Proof-Backed Context**

Every claim AtlasMemory makes links to an *anchor* — a specific line range in your code with a content hash. If the code changes, the anchor is marked stale. No hallucinations.

**2. Drift-Resistant Sessions**

Context contracts capture a SHA-256 snapshot of your database state + git HEAD. If the repo changes mid-session, AtlasMemory detects it and warns your AI agent. No stale context.

**3. Token-Budgeted Packs**

TaskPacks are greedy-optimized context windows that fit within your token budget. Priority layers: objectives > folder summaries > file cards > flow traces > symbol cards > snippets.

## MCP Tools

AtlasMemory exposes these tools via the [Model Context Protocol](https://modelcontextprotocol.io):

| Tool | Description |
|------|-------------|
| `search_repo` | Full-text + graph-boosted search |
| `build_task_pack` | Generate proof-backed context for a task |
| `bootpack` | Compact project bootstrap (~1500 tokens) |
| `deltapack` | Changes since last session |
| `prove_claim` | Find evidence for a specific claim |
| `prove_claims` | Batch prove with dedup and budgeting |
| `index_repo` | Full or incremental indexing |
| `index_file` | Parse and index a single file |
| `session_bootstrap` | Bootstrap fresh or resume sessions |
| `handshake` | Short operating instructions |
| `get_context_contract` | Check drift status |

## Architecture

```
atlasmemory (npm package)
├── packages/core        — Shared types (Anchor, FileCard, FlowCard)
├── packages/store       — SQLite + FTS5 database
├── packages/indexer     — Tree-sitter parsing (TS/JS/Python)
├── packages/retrieval   — Multi-stage search + graph proximity
├── packages/summarizer  — Deterministic card generation
├── packages/taskpack    — Token budgeting, proofs, contracts
└── dist/atlasmemory.js  — Single bundled binary (esbuild)
```

## Supported Languages

| Language | Parser | Status |
|----------|--------|--------|
| TypeScript / JavaScript | tree-sitter-typescript | Stable |
| Python | tree-sitter-python | Stable |
| More languages | Community PRs welcome | Planned |

## Configuration

AtlasMemory works with zero configuration. Optional settings:

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `ATLAS_DB_PATH` | `.atlas/atlas.db` | Database location |
| `ATLAS_LLM_API_KEY` | — | OpenAI key for LLM-enhanced cards |
| `ATLAS_CONTRACT_ENFORCE` | `warn` | Contract mode: `strict` / `warn` / `off` |

## Development

```bash
git clone https://github.com/Bpolat0/atlasmemory.git
cd atlasmemory
npm install
npm run build          # Build all packages
npm run build:bundle   # Bundle into dist/atlasmemory.js
npm run eval:synth100  # Run evaluation suite
```

## License

[MIT](LICENSE)
