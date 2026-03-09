
import fs from 'fs';
import path from 'path';

interface RepoConfig {
    rootPath: string;
    fileCount: number;
    depth: number;
    symbolDensity: number; // symbols per file
}

export class SyntheticRepoGenerator {
    private needles: { type: string, value: string, file: string }[] = [];
    private purposes: { purpose: string, file: string }[] = [];
    private flowNeedles: { file: string, from: string, to: string }[] = [];

    constructor(private config: RepoConfig) { }

    generate() {
        if (fs.existsSync(this.config.rootPath)) {
            fs.rmSync(this.config.rootPath, { recursive: true, force: true });
        }
        fs.mkdirSync(this.config.rootPath, { recursive: true });

        console.log(`Generating synthetic repo at ${this.config.rootPath}...`);

        const files = [];
        for (let i = 0; i < this.config.fileCount; i++) {
            const fileName = `file_${i}.ts`;
            const dirDepth = i % this.config.depth;
            const dirPath = path.join(this.config.rootPath, ...Array(dirDepth).fill('sub').map((s, idx) => `${s}_${idx}`));

            if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
            }

            const filePath = path.join(dirPath, fileName);
            const content = this.generateContent(i, files, fileName); // Pass filename for recording
            fs.writeFileSync(filePath, content);
            files.push(filePath);
        }

        // Write metadata
        fs.writeFileSync(path.join(this.config.rootPath, 'metadata.json'), JSON.stringify({
            needles: this.needles,
            purposes: this.purposes,
            flowNeedles: this.flowNeedles
        }, null, 2));

        return files;
    }

    private generateContent(index: number, existingFiles: string[], fileName: string): string {
        // Types only file? (Skip index 0 as it has special purpose)
        if (index % 10 === 0 && index !== 0) {
            return `// Types Only\nexport interface Type_${index} { field: string; }\n`;
        }

        // Generate a random purpose
        const purposeActions = ['handles', 'processes', 'validates', 'optimizes', 'audits', 'caches', 'buffers'];
        const purposeTargets = ['payments', 'user data', 'network requests', 'memory configuration', 'file uploads', 'security tokens', 'database connections'];

        const action = purposeActions[Math.floor(Math.random() * purposeActions.length)];
        const target = purposeTargets[Math.floor(Math.random() * purposeTargets.length)];
        let purpose = `${action} ${target}`;

        // Ensure we cover hardcoded objectives
        if (index === 0) purpose = 'investigates system architecture';
        if (index === 1) purpose = 'finds memory leaks';

        // Purpose Comment (Phase 9 requirement)
        let content = `// Synthetic File ${index}\n`;
        content += `// purpose: ${purpose}\n\n`;

        // Record purpose for eval
        if (Math.random() < 0.2) { // Record 20% of purposes to keep metadata manageable
            this.purposes.push({ purpose: purpose, file: fileName });
        }

        // Imports (Chain)
        if (existingFiles.length > 0 && index % 3 !== 0) {
            const dep = existingFiles[Math.floor(Math.random() * existingFiles.length)];
            content += `import { func_${Math.floor(Math.random() * 100)} } from './${path.basename(dep, '.ts')}';\n`;
        }

        content += `\n`;

        // Symbols
        const terms = ['system', 'architecture', 'memory', 'leak', 'optimization', 'buffer', 'cache', 'audit'];

        for (let s = 0; s < this.config.symbolDensity; s++) {
            const symName = `func_${index}_${s}`;
            const randomTerm = terms[Math.floor(Math.random() * terms.length)];
            content += `/**\n * Purpose of ${symName} is to do synthetic work related to ${randomTerm}.\n * @public\n */\n`;
            content += `export function ${symName}(arg: string): void {\n`;
            content += `    console.log("Processing " + arg);\n`;

            if (s === 0 && this.config.symbolDensity > 1) {
                const targetName = `func_${index}_1`;
                content += `    ${targetName}(arg);\n`;

                if (index % 2 === 0) {
                    this.flowNeedles.push({
                        file: fileName,
                        from: symName,
                        to: targetName
                    });
                }
            }

            // Inject needles randomly
            if (Math.random() < 0.05) {
                const needle = `NEEDLE_${Math.random().toString(36).substring(7)}`;
                content += `    // Vital secret: ${needle}\n`;
                this.needles.push({ type: 'content_keyword', value: needle, file: fileName });
            }

            content += `}\n\n`;
        }

        return content;
    }
}
