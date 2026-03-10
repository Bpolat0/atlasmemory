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
        if (process.stdin.isTTY || process.stdout.isTTY) {
            console.log(`
  AtlasMemory v${VERSION}
  ${DESCRIPTION}

  Quick Start:
    atlasmemory index .          Index current directory
    atlasmemory search "query"   Search your codebase
    atlasmemory generate         Generate CLAUDE.md / .cursorrules
    atlasmemory demo             See it in action
    atlasmemory --help           Show all commands

  MCP Server (for AI tools):
    atlasmemory serve            Start MCP server on stdio
`);
            return;
        }
        await startMcpServer({ dbPath: options.db });
    });

// Register all CLI subcommands
registerCliCommands(program);

program.parse();
