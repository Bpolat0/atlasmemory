import { Store } from '@atlasmemory/store';
import type { ContextContract, ContextSnapshot, ContractReason, DbSignature } from '@atlasmemory/core';
import { canonicalJson, sha256 } from '@atlasmemory/core';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export type ContractEnforcementMode = 'off' | 'warn' | 'strict';

export interface EvaluateContractOptions {
    sessionId?: string;
    providedContractHash?: string;
    enforce?: ContractEnforcementMode;
}

export class ContextContractService {
    constructor(private store: Store, private repoRoot: string = process.cwd()) {}

    createContractHash(snapshot: ContextSnapshot): string {
        const whitelist = [
            'repoId',
            'gitHead',
            'dbSig',
            'bootpackHash',
            'deltapackHash',
            'taskpackHash',
            'proofMode',
            'minDbCoverage'
        ];
        const canonical = canonicalJson(snapshot, whitelist, true);
        return sha256(canonical);
    }

    createSnapshot(input: Omit<ContextSnapshot, 'id' | 'createdAt' | 'repoId' | 'dbSig' | 'gitHead'> & {
        sessionId?: string;
        dbSig?: DbSignature;
        gitHead?: string;
    }): { snapshot: ContextSnapshot; contractHash: string } {
        const snapshot: ContextSnapshot = {
            id: crypto.randomUUID(),
            sessionId: input.sessionId,
            createdAt: new Date().toISOString(),
            repoId: this.getRepoId(),
            gitHead: input.gitHead ?? this.getGitHead(),
            dbSig: input.dbSig ?? this.store.getDbSignature(this.repoRoot),
            bootpackHash: input.bootpackHash,
            deltapackHash: input.deltapackHash,
            taskpackHash: input.taskpackHash,
            objective: input.objective,
            budgets: input.budgets,
            proofMode: input.proofMode,
            minDbCoverage: input.minDbCoverage
        };
        const contractHash = this.createContractHash(snapshot);
        this.store.createSnapshot(snapshot, contractHash);
        return { snapshot: { ...snapshot, contractHash }, contractHash };
    }

    evaluateContract(options: EvaluateContractOptions = {}): ContextContract {
        const latest = this.store.getLatestSnapshot(options.sessionId);
        if (!latest) {
            return {
                contractHash: '',
                isStale: true,
                shouldBlock: true,
                requiredBootstrap: true,
                reasons: ['NO_SNAPSHOT']
            };
        }

        const reasons: ContractReason[] = [];
        const currentDbSig = this.store.getDbSignature(this.repoRoot);
        if (!this.sameDbSig(latest.dbSig, currentDbSig)) {
            reasons.push('DB_CHANGED');
        }

        if (latest.gitHead) {
            const currentHead = this.getGitHead();
            if (currentHead && currentHead !== latest.gitHead) {
                reasons.push('GIT_HEAD_CHANGED');
            }
        }

        if (typeof latest.minDbCoverage === 'number') {
            const coverage = this.computeCoverageRatio();
            if (coverage < latest.minDbCoverage) {
                reasons.push('COVERAGE_LOW');
            }
        }

        const snapshotHash = latest.contractHash || this.createContractHash(latest);
        if (options.providedContractHash && options.providedContractHash !== snapshotHash) {
            reasons.push('CONTRACT_MISMATCH');
        }

        const enforce: ContractEnforcementMode = options.enforce || 'warn';
        const isStale = reasons.length > 0;
        const shouldBlock = enforce === 'strict' ? isStale : false;

        return {
            contractHash: snapshotHash,
            isStale,
            shouldBlock,
            requiredBootstrap: shouldBlock,
            reasons,
            snapshot: { ...latest, contractHash: snapshotHash }
        };
    }

    acknowledgeContext(contractHash: string, sessionId?: string) {
        const snapshot = this.store.getSnapshotByContractHash(contractHash);
        if (!snapshot) return false;
        this.store.setState('last_ack_contract_hash', contractHash, sessionId);
        return true;
    }

    getRepoId(): string {
        const normalizedRoot = path.resolve(this.repoRoot).replace(/\\/g, '/').toLowerCase();
        return sha256(normalizedRoot);
    }

    getGitHead(): string | undefined {
        try {
            const out = execSync('git rev-parse HEAD', {
                encoding: 'utf-8',
                cwd: this.repoRoot,
                stdio: ['ignore', 'pipe', 'ignore']
            }).trim();
            return out || undefined;
        } catch {
            return undefined;
        }
    }

    private sameDbSig(a?: DbSignature, b?: DbSignature): boolean {
        if (!a || !b) return false;
        return canonicalJson(a, undefined, true) === canonicalJson(b, undefined, true);
    }

    private computeCoverageRatio(): number {
        // DB stores relative paths — just count indexed files
        const indexed = this.store.getFiles().length;

        let discoverable = 0;
        const walk = (dir: string) => {
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                const full = path.resolve(dir, entry.name);
                if (entry.isDirectory()) {
                    if (['node_modules', '.git', '.atlas', 'dist', 'build', 'coverage', 'out', '.cache', '.turbo'].includes(entry.name)) continue;
                    const normalized = full.replace(/\\/g, '/').toLowerCase();
                    if (normalized.includes('/apps/eval/reports/')) continue;
                    walk(full);
                    continue;
                }

                const lower = entry.name.toLowerCase();
                const isCode = lower.endsWith('.ts') || lower.endsWith('.js') || lower.endsWith('.py');
                const excluded = lower.endsWith('.d.ts') || lower.endsWith('.map') || /\.min\.[^./]+$/.test(lower);
                if (isCode && !excluded) discoverable++;
            }
        };

        walk(this.repoRoot);
        if (discoverable === 0) return 1;
        return indexed / discoverable;
    }
}
