import crypto from 'crypto';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function sha256(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(
    obj: unknown,
    whitelistFields?: string[],
    sortedKeys: boolean = true
): string {
    const normalized = normalize(obj as JsonValue, whitelistFields ? new Set(whitelistFields) : undefined, sortedKeys, 0);
    return JSON.stringify(normalized);
}

function normalize(
    value: JsonValue,
    whitelist?: Set<string>,
    sortedKeys: boolean = true,
    depth: number = 0
): JsonValue {
    if (value === null || typeof value !== 'object') {
        return value;
    }

    if (Array.isArray(value)) {
        const normalized = value.map(item => normalize(item, undefined, sortedKeys, depth + 1));
        if (normalized.every(item => item === null || ['string', 'number', 'boolean'].includes(typeof item))) {
            return [...normalized].sort((a, b) => String(a).localeCompare(String(b)));
        }
        return [...normalized].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }

    const entries = Object.entries(value)
        .filter(([key]) => (depth === 0 && whitelist ? whitelist.has(key) : true))
        .map(([key, val]) => [key, normalize(val as JsonValue, undefined, sortedKeys, depth + 1)] as const);

    const ordered = sortedKeys ? entries.sort((a, b) => a[0].localeCompare(b[0])) : entries;
    const out: { [key: string]: JsonValue } = {};
    for (const [key, val] of ordered) {
        out[key] = val;
    }
    return out;
}
