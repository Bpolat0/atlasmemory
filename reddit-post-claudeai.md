# I built an open-source memory layer for AI coding agents — it cuts token usage by 60-80% by giving Claude persistent, evidence-backed codebase awareness

Everyone's been talking about skyrocketing token consumption lately. I've been feeling the same pain — watching Claude re-read dozens of files every session, re-discover the same architecture, burn through context just to get back to where we were yesterday.

So I spent the last 6 months building **AtlasMemory** — a local-first neural memory system that gives AI agents persistent, proof-backed understanding of your entire codebase. Think of it as a **semantic knowledge graph** that sits between your code and your AI agent, serving precisely the right context at the right time — nothing more, nothing less.

---

## The Problem (Why This Exists)

Every time Claude starts a new session on your codebase:

1. **Zero memory** — it doesn't know your architecture, conventions, or what changed yesterday
2. **Context explosion** — it reads 30-50 files just to understand one feature flow
3. **Token waste** — 8,000-12,000 tokens burned on context that should already be known
4. **Hallucination risk** — without evidence anchoring, claims about your code are just guesses
5. **Drift blindness** — no way to know if its understanding is stale

This gets exponentially worse as your codebase grows. A 500-file project? Manageable. A 28,000-file monorepo? Unusable without something like this.

---

## What AtlasMemory Actually Does

AtlasMemory indexes your repository using **Tree-sitter AST parsing** (the same parser GitHub uses for syntax highlighting), builds a **SQLite knowledge graph** with full-text search, and serves **token-budgeted context packs** through the Model Context Protocol (MCP).

### The Architecture (Simplified)

```
Your Codebase
    ↓
[Tree-sitter AST Parser] — 11 languages supported
    ↓
Symbols + Anchors + Import Graph + Cross-References
    ↓
[SQLite + FTS5 Knowledge Graph] — local, encrypted, fast
    ↓
[Evidence-Backed File Cards] — every claim links to line ranges + SHA-256 hashes
    ↓
[Token-Budgeted Context Engine] — you set the limit, it prioritizes what matters
    ↓
[MCP Protocol] → Claude / Cursor / Copilot / Windsurf / Codex
```

### What Makes It Different

**Evidence Anchoring** — This is the core innovation. Every claim AtlasMemory makes about your code is backed by an "anchor" — a specific line range with a SHA-256 snippet hash. If the code changes and the hash doesn't match, the claim is automatically flagged as stale. No more hallucinated function signatures or phantom API endpoints.

**Proof System** — You can ask AtlasMemory to *prove* any claim:
```
prove("handleLogin validates JWT tokens before checking permissions")
→ PROVEN (3 evidence anchors, confidence: 0.94)
  → src/auth/login.ts:45-62 [hash: a7f3c...]
  → src/middleware/jwt.ts:12-28 [hash: 9e2b1...]
  → tests/auth.test.ts:89-104 [hash: 3d8f0...]
```

**Drift Detection** — Context contracts track the state of your repo. If files change after context was built, AtlasMemory warns the agent before it acts on stale information.

**Impact Analysis** — Before touching shared code, ask "who depends on this?" and get a full dependency graph with risk assessment:
```
analyze_impact("Store")
→ MEDIUM RISK: 4 files, 42 symbols, 12 flows affected
→ Direct: cli.ts (17 refs), mcp-server.ts (17 refs)
→ No tests found — consider adding before changes
```

---

## Real Numbers

| Metric | Without AtlasMemory | With AtlasMemory |
|--------|-------------------|-----------------|
| Session startup context | 8,000-12,000 tokens | ~2,000 tokens |
| Files read to understand architecture | 30-50 | 0 (served from memory) |
| Time to find relevant code | 10-30s (grep/read) | <15ms (semantic search) |
| Hallucination risk | High (no verification) | Low (evidence-anchored) |
| Cross-session memory | None | Full (decisions, patterns, context) |

**Stress-tested on real repos:**
- Express.js (580 files) → indexed in 3.2s, search <15ms
- Fastify (740 files) → indexed in 4.1s
- Next.js monorepo (28,000 files) → handles enterprise scale
- Coolify (1,400+ PHP/JS files) → multi-language indexing

---

## What's Included (Full Ecosystem)

This isn't just a CLI tool — it's a complete ecosystem:

| Component | Status | Link |
|-----------|--------|------|
| **MCP Server** | 28 tools, works with any MCP-compatible AI | `npx -y atlasmemory` |
| **CLI** | Full command-line interface | `npm i -g atlasmemory` |
| **VS Code Extension** | Dashboard, sidebar, status bar | [Marketplace](https://marketplace.visualstudio.com/items?itemName=Automiflow.atlasmemory-vscode) |
| **npm Package** | One-command install | [npmjs.com/package/atlasmemory](https://www.npmjs.com/package/atlasmemory) |
| **5 AI Configs** | Claude, Cursor, Copilot, Windsurf, Codex | Auto-generated |
| **11 Languages** | TS, JS, Python, Go, Rust, Java, C#, C, C++, Ruby, PHP | Tree-sitter based |

---

## Setup (Literally 30 Seconds)

**For Claude Desktop / Claude Code:**
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

That's it. First `handshake` call auto-indexes your repo. Every session after that gets instant, proof-backed context.

**For VS Code:** Search "AtlasMemory" in extensions → Install → Done.

**For CLI power users:**
```bash
npm install -g atlasmemory
cd your-project
atlas index          # Index once
atlas search "auth"  # Semantic search
atlas enrich         # AI-enhanced descriptions (free with Claude CLI)
```

---

## MCP Tools Available (28 Total)

The key ones AI agents use:

| Tool | What It Does |
|------|-------------|
| `handshake` | Session init — project brief + memory + protocol in one call |
| `search_repo` | Semantic search with co-change intelligence |
| `build_context` | Token-budgeted context packs with proof |
| `prove` | Verify claims against actual code evidence |
| `analyze_impact` | Dependency graph + risk assessment |
| `log_decision` | Persistent memory of changes and reasoning |
| `smart_diff` | Enriched diffs with semantic understanding |
| `enrich_files` | AI-enhanced semantic tags for better search |

---

## How It Actually Feels

Before AtlasMemory:
> "Let me read your project structure... *reads 40 files*... okay I think the auth is in src/auth but I'm not sure about the middleware chain..."

After AtlasMemory:
> "Based on the project brief: auth flow goes through `src/middleware/jwt.ts` (line 12-28) → `src/auth/login.ts` (line 45-62). 3 evidence anchors confirm JWT validation happens before permission checks. Impact: 4 dependent files, no breaking changes expected."

---

## Philosophy

- **100% Local** — your code never leaves your machine. No cloud, no API keys for core features
- **Evidence > Hallucination** — every claim backed by line ranges and cryptographic hashes
- **Deterministic Core** — the engine is pure AST extraction, no LLM required for basic operation
- **Token-Aware** — greedy priority budgeting fits any context window
- **Drift-Resistant** — stale context is automatically detected and flagged

---

## Open Source (GPL-3.0)

GitHub: [github.com/Bpolat0/atlasmemory](https://github.com/Bpolat0/atlasmemory)

Stars are appreciated — I'm a solo developer building this in my spare time, and every star helps with visibility.

If you try it, I'd love to hear your experience. What works, what breaks, what features you'd want. This is built for the community.

---

*Built with TypeScript, Tree-sitter, SQLite, and way too much coffee.*