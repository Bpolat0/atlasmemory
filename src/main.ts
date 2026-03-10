import { Command } from 'commander';
import { startMcpServer } from './mcp-server.js';
import { registerCliCommands } from './cli.js';
import { VERSION, DESCRIPTION } from './version.js';

const program = new Command();
program
    .name('atlasmemory')
    .description(DESCRIPTION)
    .version(VERSION);

// Default command: start MCP server (for Claude Desktop / Cursor / VS Code)
program.command('serve', { isDefault: true })
    .description('Start MCP server (default when no command given)')
    .option('--db <path>', 'Database path (default: .atlas/atlas.db)')
    .action(async (options) => {
        if (process.stdin.isTTY) {
            console.log(`
  AtlasMemory v${VERSION}
  ${DESCRIPTION}

  Quick Start:
    atlasmemory index .          Index current directory
    atlasmemory search "query"   Search your codebase
    atlasmemory generate         Generate CLAUDE.md / .cursorrules
    atlasmemory status           Show project status
    atlasmemory doctor           Run health diagnostics
    atlasmemory demo             See it in action
    atlasmemory --help           Show all commands

  MCP Server:
    This command starts the MCP server for AI tool integration.
    It is typically called by Claude Desktop, Cursor, or VS Code.
`);
            return;
        }
        await startMcpServer({ dbPath: options.db });
    });

// Register all CLI subcommands
registerCliCommands(program);

program.parse();
