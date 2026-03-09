import { Store } from '@atlasmemory/store';
import { GraphService } from './graph.js';

export class SearchService {
    private graphService: GraphService;

    constructor(private store: Store) {
        this.graphService = new GraphService(store);
        this.graphService.buildGraph(); // Build initial graph (could be optimizing later)
    }

    search(query: string, limit: number = 10): any[] {
        const normalizedQuery = this.normalizeQuery(query);
        const terms = normalizedQuery.split(' ').filter(t => t.length > 2);

        // 1. Primary Search (FTS + Path)
        let baseResults = this.store.scoredSearch(query, limit * 2);

        // 1b. If low results, try normalized query if different
        if (baseResults.length < limit && normalizedQuery !== query.toLowerCase()) {
            const normResults = this.store.scoredSearch(normalizedQuery, limit * 2);
            // Merge logic (naive)
            for (const res of normResults) {
                if (!baseResults.find(r => r.file.id === res.file.id)) {
                    baseResults.push(res);
                }
            }
        }

        // 2. Fallback: Folder Cards (Semantic/High-level)
        if (baseResults.length === 0 && terms.length > 0) {
            // Search folder cards logic
            try {
                // Simple LIKE on card_level0/1
                // We use the normalized terms
                const term = terms[0]; // Pick main term
                const folderRows = this.store.db.prepare(`
                    SELECT folder_path FROM folder_cards 
                    WHERE card_level0 LIKE ? OR card_level1 LIKE ? 
                    LIMIT 5
                `).all(`%${term}%`, `%${term}%`) as { folder_path: string }[];

                for (const row of folderRows) {
                    // Get all files in this folder
                    const files = this.store.db.prepare('SELECT * FROM files WHERE path LIKE ? LIMIT 5').all(`${row.folder_path}%`) as any[];
                    for (const f of files) {
                        if (!baseResults.find(r => r.file.id === f.id)) {
                            baseResults.push({ file: f, score: 5 }); // Low score but exists
                        }
                    }
                }
            } catch (e) { }
        }

        // 3. Fallback: Graph Centrality (Dead fallback)
        if (baseResults.length === 0) {
            const centralIds = this.graphService.getCentralNodes(5);
            for (const id of centralIds) {
                const files = this.store.db.prepare('SELECT * FROM files WHERE id = ?').all(id) as any[];
                if (files.length > 0) {
                    baseResults.push({ file: files[0], score: 1 }); // Min score
                }
            }
        }

        // 4. Expand with Graph Proximity
        if (baseResults.length === 0) return [];

        const seedIds = baseResults.map(r => r.file.id);
        const graphScores = this.graphService.expand(seedIds, 1, 0.5);

        // 5. Merge & Rank
        const finalResults = new Map<string, { file: any, score: number, confidence: string }>();

        for (const res of baseResults) {
            let confidence = 'High';
            if (res.score < 50) confidence = 'Medium';
            if (res.score < 10) confidence = 'Low';
            finalResults.set(res.file.id, { ...res, confidence });
        }

        // Add neighbors
        const newIds = Array.from(graphScores.keys()).filter(id => !finalResults.has(id));
        for (const id of newIds) {
            const files = this.store.db.prepare('SELECT * FROM files WHERE id = ?').all(id) as any[];
            if (files.length > 0) {
                finalResults.set(id, { file: files[0], score: 0, confidence: 'Low' });
            }
        }

        // Apply Boost
        for (const [id, boost] of graphScores) {
            if (finalResults.has(id)) {
                const item = finalResults.get(id)!;
                item.score += (boost * 15);
            }
        }

        return Array.from(finalResults.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    private normalizeQuery(query: string): string {
        // CamelCase -> camel case
        let text = query.replace(/([a-z])([A-Z])/g, '$1 $2');
        // snake_case -> snake case
        text = text.replace(/_/g, ' ');
        // kebab-case -> kebab case
        text = text.replace(/-/g, ' ');

        return text.toLowerCase()
            .replace(/_/g, ' ') // Treat underscore as separator
            .replace(/[^a-z0-9\s]/g, '') // Remove punctuation
            .split(/\s+/)
            .filter(w => w.length > 2) // Remove short words
            .filter(w => !['the', 'and', 'for', 'with', 'fix', 'bug', 'use', 'explain', 'describe', 'investigate', 'find', 'logic'].includes(w)) // Stopwords
            .join(' ');
    }
}
