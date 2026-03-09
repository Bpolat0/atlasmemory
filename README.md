# AtlasMemory

AtlasMemory is a tool designed to provide persistent, drift-free context for LLMs working on large repositories.

## Architecture

- **packages/core**: Shared types.
- **packages/store**: SQLite database abstraction.
- **packages/indexer**: Tree-sitter based symbol extraction.
- **packages/summarizer**: deterministic card generation.
- **packages/retrieval**: Search and graph traversal.
- **packages/taskpack**: Context packaging with token budgeting.
- **apps/cli**: Command line interface.
- **apps/mcp-server**: Model Context Protocol server.

## Getting Started

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Build**:
    ```bash
    npm run build
    ```

3.  **Use CLI**:
    ```bash
    # Initialize in the current directory
    node apps/cli/dist/index.js init

    # Index the current directory
    node apps/cli/dist/src/index.js index

    # Index with LLM Semantic Summarization (Optional)
    # Requires OpenAI API Key
    node apps/cli/dist/src/index.js index --llm --api-key sk-...

    # Search
    node apps/cli/dist/src/index.js search "MyClass"
    ```

4.  **Use MCP Server**:
    Configure your LLM client/host to use `apps/mcp-server/dist/index.js` with stdio transport.
