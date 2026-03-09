import crypto from 'crypto';
import type { Anchor } from '@atlasmemory/core';

export function hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}

export function hashRange(content: string, startLine: number, endLine: number): string {
    const lines = content.split('\n');
    const snippet = lines.slice(startLine - 1, endLine).join('\n'); // 1-indexed input
    return hashContent(snippet);
}

export function createAnchor(fileId: string, startLine: number, endLine: number, content: string): Anchor {
    return {
        id: crypto.randomUUID(),
        fileId,
        startLine,
        endLine,
        snippetHash: hashRange(content, startLine, endLine)
    };
}
