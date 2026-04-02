# Open-source MCP server that gives Claude Code persistent codebase memory — proof-backed context, drift detection, and impact analysis in ~2000 tokens

I got tired of watching Claude Code burn tokens re-discovering my codebase every session. Same files read over and over, same architecture questions, same context building — except now it costs more each time. So I built a memory layer.

**AtlasMemory** is an MCP server that indexes your repo with Tree-sitter, builds evidence-backed summaries in a local SQLite graph, and serves token-budgeted context through 28 MCP tools. Claude calls `handshake` once and gets a complete project brief with architecture map, recent changes, risk hotspots, and cross-session memory — all backed by line-level evidence anchors with SHA-256 verification.

---

## Quick Setup

Add to your `claude_desktop_config.json` or MCP settings:

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

First `handshake` auto-indexes your repo. Every session after: instant context.

---

## What It Actually Does Under the Hood

```
Files → [Tree-sitter AST] → Symbols + Anchors + Import Graph
  → [SQLite + FTS5] → Evidence-Backed File Cards
  → [Token Budget Engine] → Optimized Context Packs
  → [MCP Protocol] → Claude gets proof-backed memory
  → [Contract Service] → Drift detection when code changes
```

**The key innovation is Evidence Anchoring.** Every claim about your code links to specific line ranges with cryptographic hashes. If the code changes, stale claims are automatically detected. This is how you prevent hallucination at the infrastructure level — not by hoping the LLM gets it right, but by making wrong claims mathematically detectable.

---

## MCP Tools (The Useful Ones)

```
handshake              → 3-layer session init (brief + memory + protocol)
search_repo            → Semantic search with co-change intelligence  
build_context          → Token-budgeted context for specific objectives
prove                  → Verify claims against actual code evidence
analyze_impact         → "Who depends on this?" with risk assessment
log_decision           → Persistent memory of what was changed and why
smart_diff             → Enriched diffs with semantic understanding
generate_claude_md     → Auto-generate AI instructions (5 formats)
enrich_files           → AI-enhanced semantic tags
```

**`build_context` example:**
```
build_context(mode="task", objective="fix login bug", budget=3000)
→ Returns: relevant files, evidence snippets, flow overview, 
  call chains, contracts — all within 3000 token budget
```

**`analyze_impact` example:**
```
analyze_impact(symbol_name="Store")
→ MEDIUM RISK: 4 files, 42 symbols, 12 flows
→ cli.ts (17 refs, high risk), mcp-server.ts (17 refs, high risk)
→ No test coverage — add tests before modifying
```

**`prove` example:**
```
prove("The indexer supports Python and Rust")
→ PROVEN: 2 anchors in packages/indexer/src/indexer.ts
→ Lines 34-45, hash: a7f3c... (Tree-sitter grammar init)
```

---

## Numbers That Matter

| | Without | With AtlasMemory |
|--|---------|-----------------|
| Session context | 8-12K tokens | ~2K tokens |
| Find relevant code | 10-30s | <15ms |
| Cross-session memory | None | Full |
| Evidence-backed claims | 0% | 100% |
| Stale context detection | None | Automatic |

**Tested on:**
- Express.js (580 files): 3.2s index, <15ms search
- Next.js (28K files): enterprise-scale, no crashes
- Coolify (1,400 PHP/JS files): multi-language

---

## Full Ecosystem

Not just an MCP server:

- **CLI:** `npm i -g atlasmemory` → `atlas index`, `atlas search`, `atlas enrich`
- **VS Code Extension:** [Marketplace](https://marketplace.visualstudio.com/items?itemName=Automiflow.atlasmemory-vscode) — dashboard, sidebar, AI readiness score
- **5 AI Config Formats:** Auto-generates CLAUDE.md, .cursorrules, copilot-instructions.md, .windsurfrules, AGENTS.md
- **11 Languages:** TypeScript, JavaScript, Python, Go, Rust, Java, C#, C, C++, Ruby, PHP
- **AI Enrichment:** `atlas enrich` adds semantic tags using Claude CLI (free) or Anthropic API

---

## What It Generates for Claude

When Claude calls `handshake`, it gets something like:

```markdown
## Project Brief
**atlasmemory** — Proof-backed AI memory for your codebase
TypeScript | 85 files | 5,326 symbols

### Architecture
- packages/intelligence/ (21) — Impact analysis, prefetch, enrichment
- packages/taskpack/ (12) — Token-budgeted context packs and proofs
- packages/store/ (7) — SQLite storage engine with FTS5 search

### Risk Map
Fragile: mcp-server.ts (churn: 100, breaks: 4)
Volatile: auto-index.ts (churn: 48)

### Health  
Files: 85 | Enriched: 84/85 (99%) | Described: 85/85
```

~2000 tokens. Full project awareness. Every session.

---

## Design Principles

1. **Local-first** — no cloud, no API keys, your code stays on your machine
2. **Evidence > trust** — claims link to line ranges + SHA-256 snippet hashes
3. **Deterministic core** — AST extraction is pure, LLM is optional enhancement
4. **Token-aware** — greedy priority budgeting, you control the limit
5. **Drift-resistant** — context contracts detect when repo state changes

---

## Open Source (GPL-3.0)

**GitHub:** [github.com/Bpolat0/atlasmemory](https://github.com/Bpolat0/atlasmemory)
**npm:** [npmjs.com/package/atlasmemory](https://www.npmjs.com/package/atlasmemory)

Solo dev, building this because I needed it and figured others might too. Stars appreciated, feedback even more so.

If you hit any issues, open a GitHub issue — I actively maintain this.

---

*TypeScript monorepo, Tree-sitter, SQLite/FTS5, ~400KB bundle. No external dependencies for core operation.*