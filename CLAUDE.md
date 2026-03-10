# AtlasMemory

## What This Is
Local-first code memory system that gives AI agents "infinite context." Indexes repos with Tree-sitter, generates evidence-backed summaries (FileCards), and packages optimized context windows (TaskPacks) within token budgets. Solves context explosion and LLM drift.

## Architecture
Monorepo (npm workspaces) with 6 packages + 3 apps:

```
packages/core       → Shared types (Anchor, CodeSymbol, FileCard, FlowCard)
packages/store      → SQLite via better-sqlite3, FTS5 search, all DB ops
packages/indexer    → Tree-sitter parsing (11 langs: TS/JS/Python/Go/Rust/Java/C#/C/C++/Ruby/PHP)
packages/retrieval  → Multi-stage search (FTS → Path → Folder → Graph)
packages/summarizer → Card generation (deterministic + optional LLM)
packages/taskpack   → Token-budgeted context packs, proof system, contracts
apps/cli            → `atlas` CLI (index, search, taskpack, bootpack, etc.)
apps/mcp-server     → MCP protocol server exposing tools to AI agents
apps/eval           → Eval harness (synth-100, synth-500, real-repo)
```

## Key Files
- **Types:** `packages/core/src/types.ts`
- **DB Schema:** `packages/store/src/schema.ts`
- **DB Operations:** `packages/store/src/store.ts`
- **Indexer:** `packages/indexer/src/indexer.ts`
- **Search:** `packages/retrieval/src/search.ts`
- **Card Generator:** `packages/summarizer/src/card-generator.ts`
- **TaskPack Builder:** `packages/taskpack/src/builder.ts`
- **Proof System:** `packages/taskpack/src/proof.ts`
- **Contract Service:** `packages/taskpack/src/contract.ts`
- **CLI:** `apps/cli/src/index.ts`
- **MCP Server:** `apps/mcp-server/src/index.ts`
- **Design Doc (TR):** `memory.md`
- **Handoff Doc:** `project_handoff.md`

## Commands
```bash
npm install              # Install all workspace deps
npm run build            # Build all packages (tsc)
npm run test             # Run tests
npm run eval             # Full eval suite (synth-100 + synth-500 + real-repo)
npm run eval:synth100    # Quick eval
npm run eval:synth500    # Medium eval
npm run eval:real        # Real-repo smoke (CI mode)
npm run eval:real:heal   # Real-repo with auto-heal (local dev)
npm run selftest:agent   # Agent self-test validation
```

## Tech Stack
- **Language:** TypeScript (ES2022, NodeNext modules, strict mode)
- **Runtime:** Node.js v18+
- **DB:** SQLite via better-sqlite3, FTS5 enabled
- **Parser:** Tree-sitter (TS, JS, Python, Go, Rust, Java, C#, C, C++, Ruby, PHP — 11 languages)
- **MCP:** @modelcontextprotocol/sdk
- **CLI:** Commander.js
- **Build:** tsc + esbuild → dist/atlasmemory.js (~200KB bundle)

## Conventions
- ESM modules throughout (`"type": "module"` in all package.json)
- Workspace references: `@atlasmemory/core`, `@atlasmemory/store`, etc.
- Path aliases: `@atlasmemory/*` maps to `packages/*/src`
- DB lives at `<repo>/.atlas/atlas.db`
- Deterministic-first: core logic is LLM-free, LLM only for Level 1+ cards
- Every claim must link to anchors (evidence-backed)
- Token budgeting uses greedy priority algorithm
- File dedup priority: .ts > .tsx > .js > .jsx > .d.ts

## Design Principles
1. **Local-first** — no external services for basic operation
2. **Evidence-backed** — claims link to anchors (line range + snippet hash)
3. **Token-aware** — greedy budgeting fits context windows
4. **Incremental** — hash-based change detection avoids full re-index
5. **Drift-resistant** — context contracts detect repo state changes
6. **Deterministic core** — LLM optional, AST extraction is pure

## Data Flow
```
Files → [Indexer/Tree-sitter] → Symbols + Anchors + Imports + Refs
  → [Store/SQLite] → [CardGenerator] → FileCards + FlowCards
  → [SearchService] → Ranked results
  → [TaskPackBuilder] → Token-budgeted markdown
  → [MCP/CLI] → LLM context
  → [ContractService] → Drift detection
```

## DB Tables
- `files`, `symbols`, `imports`, `refs`, `anchors` — raw indexed data
- `file_cards`, `symbol_cards`, `flow_cards`, `folder_cards`, `project_card` — summaries
- `session_state`, `context_snapshots` — session tracking
- `fts_files`, `fts_symbols` — FTS5 virtual tables

## MCP Tools
Primary: `search_repo`, `build_context`, `prove`, `index_repo`, `index_file`, `generate_claude_md`, `ai_readiness`, `handshake`, `get_context_contract`, `acknowledge_context`
Legacy (deprecated): `build_task_pack`, `bootpack`, `deltapack`, `session_bootstrap`, `prove_claim`, `prove_claims`
Card mgmt: `get_allowed_evidence`, `validate_file_card`, `upsert_file_card`, `refresh_cards_for_changed_files`, `auto_refresh`

## Evaluation
- **synth-100/500:** Synthetic repos with known ground truth
- **real-repo:** Smoke test on actual codebase (10 objectives)
- **Targets:** Zero-result rate <2%, Recall@5 >0.9, p95 latency <50ms
- Reports written to `apps/eval/reports/<timestamp>/`

## Current Status
Phases 1-18 complete. Phase 18: Revolution — multi-language (7 langs), MCP consolidation, overwrite protection, .atlasignore, demo command, README rewrite. See `project_handoff.md` for full history.
