import { Store } from '@atlasmemory/store';
import { LLMService } from './llm.js';
import { CardGenerator } from './card-generator.js';
import { scoreFileCard } from './scorer.js';
import { Indexer } from '@atlasmemory/indexer';
// @ts-ignore
import crypto from 'crypto';
// @ts-ignore
import fs from 'fs';
// @ts-ignore
import path from 'path';

export interface RefreshStats {
    processed: number;
    generated: number;
    failed: number;
    errors: { path: string, error: string }[];
}

export class AutoRefresher {
    private generator: CardGenerator;
    private indexer: Indexer;

    constructor(
        private store: Store,
        private llmService: LLMService
    ) {
        this.generator = new CardGenerator(llmService);
        this.indexer = new Indexer();
    }

    async findStaleFiles(limit: number = 10): Promise<string[]> {
        // Find files where:
        // 1. No card exists
        // 2. Card exists but file.updated_at > card.updated_at

        const files = this.store.getFiles(); // Naive get all
        const cards = this.store.db.prepare('SELECT file_id, updated_at FROM file_cards').all() as { file_id: string, updated_at: string }[];

        const cardMap = new Map<string, string>();
        for (const c of cards) cardMap.set(c.file_id, c.updated_at);

        const staleFiles: string[] = [];

        // Also check actual file on disk timestamp vs DB timestamp?
        // 'atlas index' handles DB sync. We assume DB is source of truth for "known files".
        // But if DB file.updated_at is updated by indexer, we check against card.
        // Wait, store.getFiles() returns {id, path, contentHash}. We need updated_at.

        // Let's get files with updated_at directly
        const dbFiles = this.store.db.prepare('SELECT id, path, updated_at FROM files').all() as { id: string, path: string, updated_at: string }[];

        for (const f of dbFiles) {
            const cardTime = cardMap.get(f.id);
            if (!cardTime) {
                // Missing card
                staleFiles.push(f.path);
            } else {
                // Check timestamp
                if (new Date(f.updated_at) > new Date(cardTime)) {
                    staleFiles.push(f.path);
                }
            }
            if (staleFiles.length >= limit) break;
        }

        return staleFiles;
    }

    async refreshFile(filePath: string): Promise<boolean> {
        try {
            if (!fs.existsSync(filePath)) return false;

            const content = fs.readFileSync(filePath, 'utf-8');

            // Cost Control: Check if change is meaningful
            const fileId = this.store.getFileId(filePath);
            if (fileId) {
                const currentHash = crypto.createHash('sha256').update(content).digest('hex');
                // Get old hash
                const file = this.store.db.prepare('SELECT content_hash FROM files WHERE id = ?').get(fileId) as { content_hash: string };
                if (file && file.content_hash !== currentHash) {
                    // Content changed. Check if it's just comments/whitespace.
                    const fts = this.store.db.prepare('SELECT content FROM fts_files WHERE file_id = ?').get(fileId) as { content: string };
                    if (fts && fts.content) {
                        if (this.stripCommentsAndWhitespace(fts.content) === this.stripCommentsAndWhitespace(content)) {
                            // Meaningless change. Update file but keep card.
                            const ext = path.extname(filePath).slice(1);
                            const loc = content.split('\n').length;
                            this.store.addFile(filePath, ext, currentHash, loc, content);
                            // Touch card timestamp to prevent staleness
                            this.store.db.prepare('UPDATE file_cards SET updated_at = datetime("now") WHERE file_id = ?').run(fileId);
                            return false;
                        }
                    }
                }
            }

            // 1. Re-index (parse only)

            const { symbols, anchors, imports } = this.indexer.parse(filePath, content);

            // Update Store basics
            const ext = path.extname(filePath).slice(1);
            const contentHash = crypto.createHash('sha256').update(content).digest('hex');
            const loc = content.split('\n').length;

            const updatedFileId = this.store.addFile(filePath, ext, contentHash, loc, content);

            // Cleanup old
            this.store.db.prepare('DELETE FROM symbols WHERE file_id = ?').run(updatedFileId);
            this.store.db.prepare('DELETE FROM anchors WHERE file_id = ?').run(updatedFileId);
            this.store.db.prepare('DELETE FROM imports WHERE file_id = ?').run(updatedFileId);

            for (const sym of symbols) {
                sym.fileId = updatedFileId;
                this.store.addSymbol(sym);
            }
            for (const anchor of anchors) {
                anchor.fileId = updatedFileId;
                this.store.upsertAnchor(anchor);
            }
            for (const imp of imports) {
                imp.fileId = updatedFileId;
                this.store.addImport(imp);
            }

            // 2. Generate Card
            const card = await this.generator.generateFileCard(updatedFileId, filePath, symbols, content, anchors);

            // 3. Score Card
            // Need re-fetched symbols/anchors? We have them.
            // But scoreFileCard needs CodeSymbol objects. 'symbols' from parse are CodeSymbols.
            const quality = scoreFileCard(card, symbols, anchors);
            card.qualityScore = quality.score;
            card.qualityFlags = quality.flags;

            // 4. Save Card
            this.store.addFileCard(card);

            return true;
        } catch (e) {
            console.error(`Failed to refresh ${filePath}:`, e);
            throw e;
        }
    }

    async refreshAll(limit: number = 10): Promise<RefreshStats> {
        const staleFiles = await this.findStaleFiles(limit);
        const stats: RefreshStats = { processed: 0, generated: 0, failed: 0, errors: [] };

        for (const filePath of staleFiles) {
            try {
                const refreshed = await this.refreshFile(filePath);
                if (refreshed) stats.generated++;
                stats.processed++;
            } catch (e: any) {
                stats.failed++;
                stats.errors.push({ path: filePath, error: e.message || String(e) });
            }
        }

        return stats;
    }

    private stripCommentsAndWhitespace(code: string): string {
        // Remove single line comments (naive)
        let cleaned = code.replace(/\/\/.*$/gm, '');
        // Remove multi-line comments
        cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
        // Remove whitespace
        return cleaned.replace(/\s+/g, '');
    }
}
