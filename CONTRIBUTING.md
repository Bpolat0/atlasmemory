# Contributing to AtlasMemory

Thank you for your interest in contributing! AtlasMemory is an open-source project and we welcome contributions from the community.

## Getting Started

### Prerequisites

- **Node.js 18+** (recommended: 20+)
- **npm 9+**
- **Git**

### Setup

```bash
git clone https://github.com/Bpolat0/atlasmemory.git
cd atlasmemory
npm install
npm run build
npm test          # Should pass all 147 tests
```

### Project Structure

```
packages/core         → Shared types
packages/store        → SQLite database operations
packages/indexer      → Tree-sitter parsing (11 languages)
packages/retrieval    → Search engine (FTS5 + graph)
packages/summarizer   → Card generation
packages/taskpack     → Context packing, proof system, contracts
packages/intelligence → Impact analysis, memory, learning
apps/vscode           → VS Code extension
apps/eval             → Evaluation harness
src/                  → Unified entry (CLI + MCP server)
```

## How to Contribute

### Reporting Bugs

1. Check [existing issues](https://github.com/Bpolat0/atlasmemory/issues) first
2. Create a new issue with:
   - Steps to reproduce
   - Expected vs actual behavior
   - Node.js version and OS
   - AtlasMemory version (`atlasmemory --version`)

### Suggesting Features

Open an issue with the `enhancement` label. Describe:
- What problem it solves
- How it should work
- Why existing features don't cover it

### Pull Requests

1. **Fork** the repository
2. **Create a branch**: `git checkout -b feature/your-feature`
3. **Make your changes**
4. **Run tests**: `npm test`
5. **Run eval** (optional): `npm run eval:synth100`
6. **Commit** with a descriptive message:
   ```
   feat: add support for Kotlin parsing
   fix: search returns wrong results for camelCase queries
   test: add edge case tests for empty repos
   docs: update MCP tools documentation
   ```
7. **Push** and open a PR against `main`

### Commit Message Format

We use [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | Usage |
|--------|-------|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `test:` | Adding or updating tests |
| `docs:` | Documentation changes |
| `chore:` | Build, CI, tooling changes |
| `perf:` | Performance improvements |

### Code Style

- **TypeScript** with strict mode
- **ESM modules** (`import/export`, not `require`)
- No unnecessary comments — code should be self-documenting
- Run `npm run build` to verify TypeScript compilation

### Testing

```bash
npm test                 # Run all 147 tests (Vitest)
npm run eval:synth100    # Quick eval (search quality)
npm run eval:synth500    # Full eval
```

- Tests use **in-memory SQLite** (no file I/O needed)
- Add tests for new features in the appropriate `__tests__/` directory
- Test file naming: `feature-name.test.ts`

### Adding Language Support

To add a new Tree-sitter language:

1. Install the grammar: `npm install tree-sitter-<lang>`
2. Add queries in `packages/indexer/src/queries.ts`
3. Register in `packages/indexer/src/indexer.ts`
4. Add tests
5. Update README language table

## Development Tips

- **Build all packages**: `npm run build`
- **Build bundle**: `npm run build:bundle`
- **Test on real repo**: `atlasmemory index . && atlasmemory search "query" && atlasmemory doctor`
- **Check AI readiness**: `atlasmemory status`
- **VS Code extension**: `cd apps/vscode && npm run build`

## Code of Conduct

Be respectful, constructive, and inclusive. We follow the [Contributor Covenant](https://www.contributor-covenant.org/).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
