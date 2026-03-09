
export interface LLMConfig {
    apiKey: string;
    endpoint?: string; // default: https://api.openai.com/v1
    model?: string; // default: gpt-4o-mini
}

export class LLMService {
    private apiKey: string;
    private endpoint: string;
    private model: string;

    constructor(config: LLMConfig) {
        this.apiKey = config.apiKey;
        this.endpoint = config.endpoint || 'https://api.openai.com/v1';
        this.model = config.model || 'gpt-4o-mini';
    }

    async summarizeFile(path: string, content: string, symbols: string[], anchors: { id: string, signature: string, startLine: number, endLine: number }[]): Promise<string> {
        const anchorList = anchors.map(a => `- [${a.id}] Lines ${a.startLine}-${a.endLine}: ${a.signature}`).join('\n');

        const prompt = `
You are an expert code analyzer.
File Path: ${path}

Symbols:
${symbols.join('\n')}

Candidate Anchors (Potential Evidence):
${anchorList}

Content Snippet (first 4000 chars):
${content.slice(0, 4000)}

Task:
Analyze this file and provide a structured summary in JSON format.
Select 1-3 most relevant anchors that support your summary (e.g. main class definition, key function).

The JSON must match this TypeScript interface:

interface Level1FileCard {
    purpose: string; // concise summary of responsibility
    publicApi: string[]; // exported functions/classes
    sideEffects: string[]; // external interactions (DB, Network, FS)
    dependencies: string[]; // key imports
    notes: string; // important considerations
    evidenceAnchorIds: string[]; // IDs of selected anchors
}

Output ONLY valid JSON.
        `.trim();

        try {
            const response = await fetch(`${this.endpoint}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify({
                    model: this.model,
                    messages: [
                        { role: 'system', content: 'You are a helpful coding assistant that outputs JSON.' },
                        { role: 'user', content: prompt }
                    ],
                    response_format: { type: "json_object" }
                })
            });

            if (!response.ok) {
                const err = await response.text();
                console.error('LLM Error:', err);
                return JSON.stringify({ purpose: 'Error generating summary' });
            }

            const data = await response.json();
            return (data as any).choices[0].message.content.trim();
        } catch (error) {
            console.error('LLM Request Failed:', error);
            return JSON.stringify({ purpose: 'Failed to generate summary' });
        }
    }
}
