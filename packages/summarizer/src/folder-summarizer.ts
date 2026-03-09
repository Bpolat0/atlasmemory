import type { FolderCard, FileCard } from '@atlasmemory/core';
// @ts-ignore
import path from 'path';

export class FolderSummarizer {

    summarizeFolder(folderPath: string, fileCards: FileCard[]): FolderCard {
        // Filter cards belonging directly to this folder (not subfolders)
        // fileCards assumed to be filtered by caller or we filter here?
        // Let's assume caller gives us relevant cards (maybe recursive or flat).
        // Standard behavior: FolderCard summarizes mostly direct children, maybe mentioning subfolders.

        // Let's filter for direct children
        const directFiles = fileCards.filter(c => path.dirname(c.path) === folderPath);

        // If no direct files, look at all provided cards?
        // Let's stick to direct files for L1.

        const targets = directFiles.length > 0 ? directFiles : fileCards;

        // 1. Synthesize Purpose
        // Pick top purposes?
        // Sort by file size (LOC)? We don't have LOC easily in card unless we look at level0/1 details.
        // Let's just take first few valid purposes.

        const uniquePurposes = new Set<string>();
        const purposes: string[] = [];

        for (const c of targets) {
            const p = c.level1?.purpose || c.level0.purpose;
            if (p && !uniquePurposes.has(p)) {
                uniquePurposes.add(p);
                purposes.push(p);
            }
        }

        const topPurposes = purposes.slice(0, 3).map(p => p.split('.')[0]).join('; ');

        const summary = `Contains ${targets.length} files. Key responsibilities: ${topPurposes}.`;

        // 2. Extract Exports
        const allExports = targets.flatMap(c => c.level1?.publicApi || c.level0.exports || []);
        const uniqueExports = Array.from(new Set(allExports)).sort().slice(0, 20); // Cap at 20

        // 3. Identify Important Files (Naive: just list first 5)
        const importantFiles = targets.slice(0, 5).map(c => ({
            path: c.path,
            purpose: c.level1?.purpose || c.level0.purpose || 'No description'
        }));

        return {
            folderPath,
            level0: {
                purpose: summary.slice(0, 150) + (summary.length > 150 ? '...' : ''),
                description: summary
            },
            level1: {
                importantFiles,
                exports: uniqueExports
            },
            updatedAt: new Date().toISOString()
        };
    }
}
