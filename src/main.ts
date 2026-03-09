#!/usr/bin/env node
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
        await startMcpServer({ dbPath: options.db });
    });

// Register all CLI subcommands
registerCliCommands(program);

program.parse();
