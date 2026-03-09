import { Store } from '@atlasmemory/store';

export interface GraphNode {
    fileId: string;
    neighbors: Map<string, number>; // neighborId -> weight
}

export class GraphService {
    private adjacency: Map<string, GraphNode> = new Map();

    constructor(private store: Store) { }

    buildGraph() {
        const imports = this.store.db.prepare(`
            SELECT file_id, resolved_file_id 
            FROM imports 
            WHERE resolved_file_id IS NOT NULL
        `).all() as { file_id: string, resolved_file_id: string }[];

        this.adjacency.clear();

        for (const imp of imports) {
            this.addEdge(imp.file_id, imp.resolved_file_id, 1.0); // Outgoing
            this.addEdge(imp.resolved_file_id, imp.file_id, 0.5); // Incoming (weaker)
        }
    }

    private addEdge(from: string, to: string, weight: number) {
        if (!this.adjacency.has(from)) {
            this.adjacency.set(from, { fileId: from, neighbors: new Map() });
        }
        const node = this.adjacency.get(from)!;
        // Accumulate weight if multiple imports
        const current = node.neighbors.get(to) || 0;
        node.neighbors.set(to, current + weight);
    }

    /**
     * Expand a set of seed file IDs with their neighbors.
     * @param seedIds Initial file IDs found by search
     * @param maxDepth How many hops to go (default 1)
     * @param decayFactor How much to reduce score per hop
     */
    expand(seedIds: string[], maxDepth: number = 1, decayFactor: number = 0.5): Map<string, number> {
        const scores = new Map<string, number>();

        // Initialize seeds
        for (const id of seedIds) {
            scores.set(id, 1.0); // Base score for seeds
        }

        let currentFrontier = new Set(seedIds);

        for (let depth = 0; depth < maxDepth; depth++) {
            const nextFrontier = new Set<string>();
            const depthWeight = Math.pow(decayFactor, depth + 1);

            for (const id of currentFrontier) {
                const node = this.adjacency.get(id);
                if (!node) continue;

                for (const [neighborId, edgeWeight] of node.neighbors) {
                    if (!scores.has(neighborId)) {
                        scores.set(neighborId, 0); // Initialize if new
                    }

                    // Score = edgeWeight * depthDecay
                    // We add to existing score to reward being neighbor of multiple seeds
                    const addedScore = edgeWeight * depthWeight;
                    scores.set(neighborId, scores.get(neighborId)! + addedScore);

                    // Add to next frontier if not already a seed (to avoid loops on seeds)
                    // Actually we want to explore from neighbors too
                    if (!currentFrontier.has(neighborId)) { // Prevent immediate backtrack loop
                        nextFrontier.add(neighborId);
                    }
                }
            }
            currentFrontier = nextFrontier;
            if (currentFrontier.size === 0) break;
        }

        return scores;
    }
    getCentralNodes(limit: number = 5): string[] {
        const degrees = Array.from(this.adjacency.values()).map(node => ({
            id: node.fileId,
            degree: node.neighbors.size
        }));
        degrees.sort((a, b) => b.degree - a.degree);
        return degrees.slice(0, limit).map(d => d.id);
    }
}
