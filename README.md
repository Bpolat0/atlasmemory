# AtlasMemory

**Give your AI agent proof-backed memory of your entire codebase.**

Every claim grounded in code. Every context window optimized. Every session drift-proof.

[![npm version](https://img.shields.io/npm/v/atlasmemory)](https://www.npmjs.com/package/atlasmemory)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Languages](https://img.shields.io/badge/languages-11-blueviolet)](#supported-languages)

## The Problem

AI coding agents hallucinate about your code. They lose context between sessions. They can't prove their claims. **AtlasMemory fixes all three.**

| Feature | Others | AtlasMemory |
|---------|--------|-------------|
| Claims about code | "Trust me" | **Proof-backed** (line + hash) |
| Session continuity | Start over | **Drift-detected** contracts |
| Context window | Dump everything | **Token-budgeted** packs |
| Dependencies | Cloud API keys | **Local-first**, zero config |
| Languages | Varies | **11 languages** (TS/JS/Python/Go/Rust/Java/C#/C/C++/Ruby/PHP) |

## 30-Second Setup

```bash
npx atlasmemory index .                        # Index your project
npx atlasmemory search "authentication"        # Search with FTS5 + graph
npx atlasmemory generate                       # Auto-generate CLAUDE.md
npx atlasmemory demo                           # See it all in action
```

## Use With Your AI Tool

### Claude Desktop / Claude Code

Add to `claude_desktop_config.json`:

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

Auto-indexes on first query. Zero config.

### Cursor

Add to `.cursor/mcp.json`:

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

### VS Code

Install the [AtlasMemory extension](https://marketplace.visualstudio.com/items?itemName=atlasmemory.atlasmemory) or use MCP config:

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

### CLI

```bash
atlasmemory init                               # Setup + index + guides
atlasmemory index .                            # Index your project
atlasmemory search "auth middleware"            # FTS5 + graph search
atlasmemory taskpack "fix login bug"            # Proof-backed context pack
atlasmemory generate                            # Auto-generate CLAUDE.md
atlasmemory status                              # AI readiness score
atlasmemory doctor                              # Health diagnostics
atlasmemory demo                                # See it in action
```

## The Proof System

**What no one else has.** Every claim AtlasMemory makes links to an *anchor* — a specific line range with a content hash.

```
Claim: "handleLogin() validates credentials before creating session"
Evidence:
  src/auth.ts:42-58 [hash:5cde2a1f] — validateCredentials() call
  src/auth.ts:60-72 [hash:a3b7c9d1] — createSession() after validation

Status: PROVEN (2 anchors, hashes match current code)
```

If the code changes and the hashes no longer match: **DRIFT DETECTED**. The AI agent knows its understanding is stale *before* it hallucinates.

## How It Works

```
Your Codebase
     |
     v
[Tree-sitter Parser] ── Extracts symbols, imports, call refs (11 languages)
     |
     v
[SQLite + FTS5] ─────── Full-text search, graph edges, anchors
     |
     v
[Card Generator] ────── Evidence-backed summaries (deterministic, no LLM needed)
     |
     v
[TaskPack Builder] ──── Token-budgeted context within your limits
     |
     v
[MCP Server] ────────── Serves tools to Claude, Cursor, Copilot
     |
     v
[Contract Service] ──── Detects drift, ensures session consistency
```

### Three Pillars

**1. Proof-Backed Context** — Every claim links to an anchor (line range + content hash). If the code changes, the anchor is marked stale. No hallucinations.

**2. Drift-Resistant Sessions** — Context contracts capture SHA-256 snapshots of database state + git HEAD. If the repo changes mid-session, AtlasMemory detects it and warns.

**3. Token-Budgeted Packs** — Greedy-optimized context windows that fit within your token budget. Priority: objectives > folder summaries > file cards > flow traces > snippets.

## Supported Languages

| Language | Status | Symbols Extracted |
|----------|--------|-------------------|
| TypeScript / JavaScript | Stable | functions, classes, methods, interfaces, types, imports, calls |
| Python | Stable | functions, classes, imports, calls |
| Go | Stable | functions, methods, structs, interfaces, imports, calls |
| Rust | Stable | functions, impl blocks, structs, traits, enums, use, calls |
| Java | Stable | methods, classes, interfaces, enums, imports, calls |
| C# | Stable | methods, classes, interfaces, structs, enums, using, calls |
| C | Stable | functions, structs, enums, #include, calls |
| C++ | Stable | functions, classes, structs, enums, #include, calls |
| Ruby | Stable | methods, classes, modules, calls |
| PHP | Stable | functions, methods, classes, interfaces, use, calls |

## MCP Tools

| Tool | Description |
|------|-------------|
| `search_repo` | Full-text + graph-boosted codebase search |
| `build_context` | **Unified context builder** — task, project, delta, or session mode |
| `prove` | **Prove claims** with evidence anchors from your codebase |
| `index_repo` | Full or incremental indexing |
| `index_file` | Parse and index a single file |
| `generate_claude_md` | Auto-generate CLAUDE.md / .cursorrules / copilot-instructions.md |
| `ai_readiness` | Compute AI Readiness Score (0-100) |
| `handshake` | Short operating instructions for AI agents |
| `get_context_contract` | Check drift status with recommended actions |

## Configuration

AtlasMemory works with **zero configuration**. Optional:

| Setting | Default | Description |
|---------|---------|-------------|
| `ATLAS_DB_PATH` | `.atlas/atlas.db` | Database location |
| `ATLAS_LLM_API_KEY` | — | API key for LLM-enhanced card descriptions |
| `ATLAS_CONTRACT_ENFORCE` | `warn` | Contract mode: `strict` / `warn` / `off` |
| `.atlasignore` | — | Custom file/directory exclusions (like .gitignore) |

## Architecture

```
atlasmemory (npm package)
├── packages/core        — Shared types (Anchor, FileCard, FlowCard, CodeSymbol)
├── packages/store       — SQLite + FTS5 search, all DB operations
├── packages/indexer     — Tree-sitter parsing (11 languages)
├── packages/retrieval   — Multi-stage search (FTS → Path → Graph)
├── packages/summarizer  — Deterministic + LLM card generation
├── packages/taskpack    — Token budgeting, proof system, contracts
├── apps/vscode          — VS Code extension (status bar, dashboard, sidebar)
└── dist/atlasmemory.js  — Single bundled binary (~200KB, esbuild)
```

## Development

```bash
git clone https://github.com/Bpolat0/atlasmemory.git
cd atlasmemory
npm install
npm run build:all        # Build all packages + bundle
npm run eval:synth100    # Quick evaluation suite
npm run eval             # Full evaluation (synth-100 + synth-500 + real-repo)
```

## Contributing

PRs welcome! See [CLAUDE.md](CLAUDE.md) for project conventions and architecture details.

## License

[MIT](LICENSE)
