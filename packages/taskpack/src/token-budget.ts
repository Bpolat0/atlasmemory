export class TokenBudgeter {
    constructor(private maxTokens: number) { }

    estimateTokens(text: string): number {
        return Math.ceil(text.length / 4);
    }

    canAdd(currentUsage: number, text: string): boolean {
        return (currentUsage + this.estimateTokens(text)) <= this.maxTokens;
    }
}
