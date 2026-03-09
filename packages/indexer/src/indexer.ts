import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
// @ts-ignore
import { TS_QUERIES, PYTHON_QUERIES } from './queries.js';
import { createAnchor } from './utils.js';
import type { CodeSymbol } from '@atlasmemory/core';
import crypto from 'crypto';

export class Indexer {
    private parsers: Record<string, Parser> = {};
    private queries: Record<string, Parser.Query> = {};

    constructor() {
        this.initParsers();
    }

    private initParsers() {
        const tsParser = new Parser();
        tsParser.setLanguage(TypeScript.typescript);
        this.parsers['ts'] = tsParser;
        this.queries['ts'] = new Parser.Query(TypeScript.typescript, TS_QUERIES);

        const pyParser = new Parser();
        pyParser.setLanguage(Python);
        this.parsers['py'] = pyParser;
        this.queries['py'] = new Parser.Query(Python, PYTHON_QUERIES);
    }

    parse(path: string, content: string): { symbols: CodeSymbol[], anchors: import('@atlasmemory/core').Anchor[], imports: import('@atlasmemory/core').Import[], refs: import('@atlasmemory/core').CodeRef[] } {
        const ext = path.split('.').pop();
        if (!ext || !this.parsers[ext]) return { symbols: [], anchors: [], imports: [], refs: [] };

        const parser = this.parsers[ext];
        const query = this.queries[ext];
        const tree = parser.parse(content);

        const symbols: CodeSymbol[] = [];
        const anchors: import('@atlasmemory/core').Anchor[] = [];
        const imports: import('@atlasmemory/core').Import[] = [];
        const captures = query.captures(tree.rootNode);

        for (const capture of captures) {
            if (capture.name === 'import') {
                const node = capture.node;
                // TS: (import_statement source: (string) @import_source)
                // Py: (import_statement (dotted_name) @import_module)

                let moduleName = '';
                if (ext === 'ts') {
                    // node is import_statement. source child is string.
                    // capture.node is the whole statement? No, @import matches the statement.
                    // queries.ts: (import_statement source: (string) @import_source) @import
                    // Wait, I have specific captures for @import_source and @import_module.
                    // But I also labeled the whole statement as @import?
                    // No, query: (import_statement source: (string) @import_source) @import
                }
            }
        }

        // Better approach: Iterate captures and check name
        // Process captures for Symbols first (to establish scope)
        for (const capture of captures) {
            if (['function', 'class', 'method', 'interface', 'type'].includes(capture.name)) {
                const node = capture.node;
                let nameNode = null;
                const cursor = node.walk();

                // Find name node
                if (cursor.gotoFirstChild()) {
                    do {
                        if (cursor.currentFieldName === 'name') {
                            nameNode = cursor.currentNode;
                            break;
                        }
                    } while (cursor.gotoNextSibling());
                }
                if (!nameNode) continue;

                const name = nameNode.text;
                const kind = capture.name as any;
                const signature = node.text.split('\n')[0];
                const signatureHash = crypto.createHash('sha256').update(signature).digest('hex');

                const startLine = node.startPosition.row + 1;
                const endLine = node.endPosition.row + 1;

                const anchor = createAnchor('', startLine, endLine, content);
                anchors.push(anchor);

                symbols.push({
                    id: crypto.randomUUID(),
                    fileId: '',
                    kind,
                    name,
                    qualifiedName: name, // Simplified
                    signature,
                    visibility: 'public',
                    startLine,
                    endLine,
                    signatureHash
                });
            }
        }

        // Process Imports
        for (const capture of captures) {
            if (capture.name === 'import_source' || capture.name === 'import_module') {
                const node = capture.node;
                let moduleName = node.text;

                if (ext === 'ts' && (moduleName.startsWith("'") || moduleName.startsWith('"'))) {
                    moduleName = moduleName.slice(1, -1);
                }

                imports.push({
                    id: crypto.randomUUID(),
                    fileId: '',
                    importedModule: moduleName,
                    isExternal: !moduleName.startsWith('.') && !moduleName.startsWith('/'),
                });
            }
        }

        // Process Calls (Refs)
        const refs: import('@atlasmemory/core').CodeRef[] = [];
        for (const capture of captures) {
            if (capture.name === 'call_name') {
                const node = capture.node;
                const callName = node.text;
                const startLine = node.startPosition.row + 1;

                // Find enclosing symbol
                // Sort symbols by range size (smallest first) to find innermost
                const enclosing = symbols
                    .filter(s => s.startLine <= startLine && s.endLine >= startLine)
                    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];

                if (enclosing) {
                    // Create anchor for context
                    const anchor = createAnchor('', startLine, startLine, content); // Single line anchor for call
                    anchors.push(anchor);

                    refs.push({
                        id: crypto.randomUUID(),
                        fromSymbolId: enclosing.id,
                        toName: callName,
                        kind: 'call',
                        anchorId: anchor.id
                    });
                }
            }
        }

        return { symbols, anchors, imports, refs };
    }
}
