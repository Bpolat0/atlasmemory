# Changelog

All notable changes to [AtlasMemory](https://www.npmjs.com/package/atlasmemory) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-03-18

First public release. Local-first code memory for AI agents — proof-backed, drift-resistant, token-budgeted.

### Added

**Core Engine**
- Tree-sitter AST parsing for 11 languages (TypeScript, JavaScript, Python, Go, Rust, Java, C#, C, C++, Ruby, PHP)
- SQLite database with FTS5 full-text search (Porter stemming, camelCase tokenization)
- Multi-stage search pipeline: FTS5 → path matching → folder context → graph proximity
- Evidence-backed claim system — every claim links to anchors (file, line range, snippet hash)
- Token-budgeted context packs (greedy priority algorithm with configurable budgets)
- Context contracts with drift detection (hash-based staleness, strict/warn modes)
- Hash-based incremental indexing — only re-indexes changed files
- Git-based staleness detection for MCP sessions (`git diff --name-status`)
- `.atlasignore` support for excluding files from indexing

**Card System**
- FileCards — per-file summaries with purpose, symbols, dependencies, semantic tags
- FlowCards — cross-file data flow documentation
- FolderCards — directory-level summaries
- ProjectCard — whole-project summary
- SymbolCards — per-symbol documentation

**Intelligence Layer**
- Impact analysis via reverse reference graph ("who calls this?")
- Prefetch engine with 3-signal prediction (co-occurrence, recency, graph proximity)
- Semantic smart diff — enriched git diffs with context
- Per-session token budget tracking
- Conversation memory — cross-session event logging and retrieval
- Session learner — file co-occurrence patterns, search boost extraction, hot path detection
- Code health analysis — git log churn, break frequency, coupling metrics
- Proactive response wrapping with intelligence section

**AI Enrichment**
- Dual-backend AI enrichment engine (Claude CLI free + Anthropic API paid)
- Optimized few-shot enrichment prompt (~500 tokens/file)
- Post-index auto-enrichment (10 files per indexing run)
- Batch enrichment — 5 files per subprocess (~70% faster than sequential)
- Exponential backoff on API rate limits (429/529, max 3 retries)
- Inter-call delay (500ms CLI, 1s API) for rate limit compliance
- `atlas enrich` CLI command with `--batch`, `--backend`, `--dry-run`, `--all` flags

**Agent Memory**
- Agent decision logging — persists AI agent decisions (what + why) across sessions
- FTS5-searchable decision history
- Delta mode smart filtering — only decisions for changed files
- Path normalization and deduplication (UNIQUE constraint)
- `log_decision` and `get_file_history` MCP tools
- `atlas decisions` CLI command with `--file`, `--search`, `--recent`, `--limit`

**Organic Memory**
- Project-level memory system (cross-session knowledge persistence)
- Living Project Brief — auto-synthesized 6-section project overview (Identity, Architecture, Recent Changes, Risk Map, Patterns, Health), token-budgeted, LLM-free

**MCP Server (28 tools)**
- Primary: `search_repo`, `build_context`, `prove`, `index_repo`, `index_file`, `generate_claude_md`, `ai_readiness`, `handshake`, `get_context_contract`, `acknowledge_context`
- Intelligence: `analyze_impact`, `smart_diff`, `remember`, `session_context`, `enrich_files`
- Agent memory: `log_decision`, `get_file_history`
- Card management: `get_allowed_evidence`, `validate_file_card`, `upsert_file_card`, `refresh_cards_for_changed_files`, `auto_refresh`
- Auto-indexes on first query, zero config

**CLI (`atlasmemory` / `atlas`)**
- `index` — Index a project (batch processing, `--max-files` flag)
- `search` — FTS5 + graph-boosted search
- `taskpack` — Build proof-backed context packs
- `generate` — Auto-generate CLAUDE.md for a project
- `status` — AI readiness score
- `doctor` — Health diagnostics
- `enrich` — AI enrichment (free CLI / paid API)
- `brief` — Living project brief (`--json`, `--tokens`)
- `decisions` — Agent decision history
- `demo` — Interactive demonstration
- `init` — Setup + index + guides

**VS Code Extension**
- Status bar integration
- Sidebar panel
- Dashboard webview

**CLAUDE.md Generator**
- Auto-generates project-specific CLAUDE.md from indexed data
- AI readiness scoring

### Performance

- FTS5 Porter stemming with camelCase-aware tokenization
- Search p95 latency under 3ms (eval benchmark)
- Recall@5 = 1.000 on synthetic benchmarks
- Zero-result rate = 0% on eval suite
- Incremental indexing via content hashing (skips unchanged files)
- 2-phase batch indexing for large repos (100 files/batch + GC hints)
- Snippet budget guarantees (min 15% of token budget reserved)
- ~394KB esbuild bundle (single file, all packages unified)

### Developer Experience

- 147 unit tests (Vitest, in-memory SQLite isolation)
  - Store CRUD + FTS5 search tests
  - TaskPack builder + proof system tests
  - Search service tests
  - Intelligence layer tests (ImpactAnalyzer, ConversationMemory, SessionLearner, DiffEnricher, EnrichmentCoordinator)
  - Contract service tests (drift detection, strict/warn mode)
  - End-to-end integration tests (Search → TaskPack → Proof → Contract)
  - MCP handler regression tests (36 tests covering all critical tools)
  - Edge case tests (empty repo, large symbol count, duplicate paths, broken UTF-8)
- GitHub Actions CI/CD pipeline (Node 18/20/22 matrix)
- Eval harness with three tiers: synth-100 (quick), synth-500 (medium), real-repo (smoke)
- DB schema v9 with automatic migrations
- Relative paths in DB, resolved at runtime (cross-platform portable)

[1.0.0]: https://github.com/Bpolat0/AtlasMemory/releases/tag/v1.0.0
