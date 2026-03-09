import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const sessionId = 'selftest';
const reportPath = path.join(root, 'AGENT-SELFTEST-REPORT.md');
const driftFile = path.join(root, 'packages', 'taskpack', 'src', '__selftest_drift__.ts');

const callStats = new Map();

function inc(name) {
  callStats.set(name, (callStats.get(name) || 0) + 1);
}

function extractJson(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function getText(result) {
  if (!result || !Array.isArray(result.content)) return '';
  return result.content.map(c => c.text || '').join('\n');
}

function tokenUsed(packText) {
  const match = String(packText || '').match(/Used:\s*~(\d+)\s*\//i);
  return match ? Number(match[1]) : 0;
}

function unprovenCount(packText) {
  return (String(packText || '').match(/S:UNPROVEN/g) || []).length;
}

function extractPackText(toolResultText) {
  const parsed = extractJson(toolResultText);
  if (parsed && typeof parsed.pack === 'string') return parsed.pack;
  return String(toolResultText || '');
}

async function connectClient(enforceMode) {
  const serverPath = path.resolve(root, 'apps', 'mcp-server', 'dist', 'src', 'index.js');
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env: {
      ...process.env,
      ATLAS_CONTRACT_ENFORCE: enforceMode,
      ATLAS_DB_PATH: path.resolve(root, '.atlas', 'atlas.db')
    }
  });

  const client = new Client({ name: `atlas-selftest-${enforceMode}`, version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

function makeTool(client, modeLabel) {
  return async (name, args = {}) => {
    inc(`${name}(${modeLabel})`);
    try {
      const result = await client.callTool({ name, arguments: args });
      const text = getText(result);
      return { ok: !result.isError, text, raw: result };
    } catch (error) {
      const message = String(error?.message || error || 'unknown error');
      const parsed = extractJson(message);
      return { ok: false, text: message, error, parsed };
    }
  };
}

function evidenceFromLine(line) {
  const m = line.match(/\|\s*E:([^\n]+)/);
  if (!m) return [];
  return m[1]
    .split(',')
    .map(x => x.trim())
    .filter(x => x && x !== 'none');
}

async function main() {
  process.env.ATLAS_DB_PATH = path.resolve(root, '.atlas', 'atlas.db');

  const warnClient = await connectClient('warn');
  const strictClient = await connectClient('strict');
  const toolWarn = makeTool(warnClient, 'warn');
  const toolStrict = makeTool(strictClient, 'strict');

  const report = {
    sessionId,
    step0: {},
    step1: { bullets: [] },
    step2: [],
    step3: {},
    step4: {},
    step5: { bullets: [] },
    proving: {
      requested: 0,
      executed: 0,
      cacheHits: 0,
      proofWorkUnitsUsed: 0
    },
    totals: {
      bootTokens: 0,
      deltaTokens: 0,
      taskTokens: 0,
      strictUnproven: 0
    }
  };

  const c0 = await toolWarn('get_context_contract', { sessionId });
  const c0Json = extractJson(c0.text) || {};

  if (Array.isArray(c0Json.reasons) && c0Json.reasons.includes('NO_SNAPSHOT')) {
    await toolWarn('index_repo', { path: root, incremental: true });
  }

  const fresh = await toolWarn('session_bootstrap', {
    sessionId,
    mode: 'fresh',
    bootBudget: 1500,
    deltaBudget: 800,
    format: 'json'
  });
  const freshJson = extractJson(fresh.text) || {};
  let contractHash = freshJson.contractHash || '';
  const bootText = String(freshJson.bootpack || '');

  report.totals.bootTokens += tokenUsed(bootText);
  report.totals.strictUnproven += unprovenCount(bootText);

  const ack = await toolWarn('acknowledge_context', { sessionId, contractHash });
  const c1 = await toolWarn('get_context_contract', { sessionId, providedContractHash: contractHash });
  const c1Json = extractJson(c1.text) || {};

  report.step0 = {
    before: { reasons: c0Json.reasons || [], shouldBlock: c0Json.shouldBlock, isStale: c0Json.isStale },
    after: { reasons: c1Json.reasons || [], shouldBlock: c1Json.shouldBlock, isStale: c1Json.isStale },
    acknowledged: ack.ok
  };

  const baselineDelta = await toolWarn('deltapack', { since: 'last', budget: 800, format: 'json', sessionId, proof: 'warn' });
  const baselineDeltaJson = extractJson(baselineDelta.text) || {};
  const baselineCapsule = String(baselineDeltaJson.capsule || '');
  report.totals.deltaTokens += tokenUsed(baselineCapsule);

  const claimLines = bootText
    .split(/\r?\n/)
    .filter(line => /^C:|^F:/.test(line))
    .filter(line => line.includes('| E:') && !line.includes('| E:none'))
    .slice(0, 6);

  report.step1.bullets = claimLines.map(line => ({
    text: line.split('| E:')[0].trim(),
    evidenceIds: evidenceFromLine(line)
  }));

  const objectives = [
    {
      objective: 'Trace ContextContractService evaluate flow and stale detection logic',
      proveClaims: [
        'ContextContractService compares current db signature with snapshot dbSig',
        'Contract reasons include CONTRACT_MISMATCH when provided hash differs'
      ]
    },
    {
      objective: 'Explain session bootstrap output contractHash/dbSig handling path',
      proveClaims: [
        'session_bootstrap returns contractHash and dbSig',
        'session_bootstrap computes bootpack hash before persisting snapshot'
      ]
    },
    {
      objective: 'Review taskpack strict proof behavior and UNPROVEN suppression',
      proveClaims: [
        'TaskPackBuilder supports strict proof mode',
        'Strict proof mode drops claims with missing evidence'
      ]
    }
  ];

  for (const item of objectives) {
    const build = await toolWarn('build_task_pack', {
      objective: item.objective,
      token_budget: 6000,
      proof: 'strict',
      sessionId,
      contractHash
    });
    const rebootstrapDuringObjective = false;

    const pack = build.ok ? extractPackText(build.text) : '';
    const taskTokens = tokenUsed(pack);
    const taskUnproven = unprovenCount(pack);
    report.totals.taskTokens += taskTokens;
    report.totals.strictUnproven += taskUnproven;

    const pr = await toolWarn('prove_claims', {
      claims: item.proveClaims.map(text => ({ text, scopePath: path.join(root, 'packages', 'taskpack', 'src') })),
      maxEvidence: 5,
      sessionId,
      diversity: true,
      proofMode: 'strict',
      proofBudget: 2500,
      contractHash
    });
    const prJson = extractJson(pr.text) || {};
    const proofs = (prJson.results || []).map((res, index) => ({
      claimText: item.proveClaims[index],
      status: res?.claim?.status || 'UNKNOWN',
      evidenceCount: Array.isArray(res?.claim?.evidenceIds) ? res.claim.evidenceIds.length : 0,
      evidenceIds: res?.claim?.evidenceIds || []
    }));

    report.proving.requested += Number(prJson.metadata?.requested || 0);
    report.proving.executed += Number(prJson.metadata?.executed || 0);
    report.proving.cacheHits += Number(prJson.metadata?.cacheHits || 0);
    report.proving.proofWorkUnitsUsed += Number(prJson.metadata?.proofWorkUnitsUsed || 0);

    report.step2.push({
      objective: item.objective,
      rebootstrapDuringObjective,
      taskTokens,
      taskUnproven,
      proofs
    });
  }

  fs.writeFileSync(
    driftFile,
    [
      "export function __selftestDriftValue(seed: number): number {",
      "  return seed * 2 + 1;",
      "}",
      ""
    ].join('\n'),
    'utf-8'
  );

  const oldContractHash = contractHash;

  const indexed = await toolWarn('index_file', { path: driftFile });

  const staleAttempt = await toolStrict('build_task_pack', {
    objective: 'Inspect __selftest_drift__.ts behavior',
    token_budget: 6000,
    proof: 'strict',
    sessionId,
    contractHash: oldContractHash
  });

  const staleAttemptJson = extractJson(staleAttempt.text) || {};
  const bootstrapRequired = !staleAttempt.ok && staleAttempt.text.includes('BOOTSTRAP_REQUIRED');

  const resume = await toolWarn('session_bootstrap', {
    sessionId,
    mode: 'resume',
    bootBudget: 1500,
    deltaBudget: 800,
    format: 'json'
  });
  const resumeJson = extractJson(resume.text) || {};
  contractHash = resumeJson.contractHash || contractHash;
  await toolWarn('acknowledge_context', { sessionId, contractHash });

  const retry = await toolWarn('build_task_pack', {
    objective: 'Inspect __selftest_drift__.ts behavior',
    token_budget: 6000,
    proof: 'strict',
    sessionId,
    contractHash
  });

  const retryPack = retry.ok ? extractPackText(retry.text) : '';
  report.totals.taskTokens += tokenUsed(retryPack);
  report.totals.strictUnproven += unprovenCount(retryPack);

  const resumedBoot = String(resumeJson.bootpack || '');
  const resumedDelta = String(resumeJson.deltapack || '');
  report.totals.bootTokens += tokenUsed(resumedBoot);
  report.totals.deltaTokens += tokenUsed(resumedDelta);

  report.step3 = {
    indexedOk: indexed.ok,
    oldContractHash,
    bootstrapRequired,
    staleReasons: staleAttemptJson.reasons || [],
    newContractHash: contractHash,
    retryOk: retry.ok && retryPack.length > 0,
    retryIncludesNewFile: retryPack.includes('__selftest_drift__.ts') || retryPack.includes('__selftest_drift__')
  };

  fs.appendFileSync(driftFile, '\nexport const __selftestDriftTouched = true;\n', 'utf-8');
  await toolWarn('index_file', { path: driftFile });

  const deltaAfterChange = await toolWarn('deltapack', {
    since: 'last',
    budget: 1200,
    format: 'json',
    sessionId,
    proof: 'warn'
  });

  const deltaAfterJson = extractJson(deltaAfterChange.text) || {};
  const changedFiles = Array.isArray(deltaAfterJson.changedFiles) ? deltaAfterJson.changedFiles : [];
  const affectedFlowIds = Array.isArray(deltaAfterJson.affectedFlowIds) ? deltaAfterJson.affectedFlowIds : [];
  const deltaCapsule = String(deltaAfterJson.capsule || '');
  report.totals.deltaTokens += tokenUsed(deltaCapsule);

  report.step4 = {
    changedFileIncluded: changedFiles.some(file => String(file).endsWith('__selftest_drift__.ts')),
    changedFilesCount: changedFiles.length,
    affectedFlowsCount: affectedFlowIds.length,
    note: affectedFlowIds.length > 0
      ? 'Affected flows detected.'
      : 'No affected flows detected for this isolated file change (acceptable).'
  };

  const reviewClaims = [
    'The file exports __selftestDriftValue as a deterministic pure function',
    'The function performs arithmetic and has no side effects',
    'The file also exports __selftestDriftTouched constant',
    'The file follows project TypeScript module style',
    'The file is indexed and retrievable through AtlasMemory search graph'
  ];

  const reviewBatch = await toolWarn('prove_claims', {
    claims: reviewClaims.map(text => ({ text, scopePath: driftFile })),
    maxEvidence: 5,
    sessionId,
    diversity: true,
    proofMode: 'strict',
    proofBudget: 2500,
    contractHash
  });
  const reviewJson = extractJson(reviewBatch.text) || {};
  (reviewJson.results || []).forEach((res, index) => {
    const claimText = reviewClaims[index];
    const evidenceIds = res?.claim?.evidenceIds || [];
    report.step5.bullets.push({
      claimText,
      status: res?.claim?.status || 'UNKNOWN',
      evidenceIds,
      cannotProve: evidenceIds.length === 0
    });
  });

  report.proving.requested += Number(reviewJson.metadata?.requested || 0);
  report.proving.executed += Number(reviewJson.metadata?.executed || 0);
  report.proving.cacheHits += Number(reviewJson.metadata?.cacheHits || 0);
  report.proving.proofWorkUnitsUsed += Number(reviewJson.metadata?.proofWorkUnitsUsed || 0);

  const totalToolCalls = Array.from(callStats.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  const lines = [];
  lines.push('# AGENT SELFTEST REPORT');
  lines.push('');
  lines.push(`Session: ${sessionId}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## 0) Contract/bootstrap discipline');
  lines.push(`- Initial reasons: ${(report.step0.before.reasons || []).join(', ') || 'none'}`);
  lines.push(`- Initial isStale/shouldBlock: ${report.step0.before.isStale} / ${report.step0.before.shouldBlock}`);
  lines.push(`- Acknowledged contract: ${report.step0.acknowledged}`);
  lines.push(`- Post-bootstrap reasons: ${(report.step0.after.reasons || []).join(', ') || 'none'}`);
  lines.push(`- Post-bootstrap isStale/shouldBlock: ${report.step0.after.isStale} / ${report.step0.after.shouldBlock}`);
  lines.push('');

  lines.push('## 1) Cold-start explanation (BootPack only, strict)');
  report.step1.bullets.forEach((b, idx) => {
    lines.push(`- ${idx + 1}. ${b.text} | evidenceIds: ${b.evidenceIds.join(', ')}`);
  });
  lines.push('');

  lines.push('## 2) Objectives (TaskPack strict + prove_claims)');
  for (const item of report.step2) {
    lines.push(`- Objective: ${item.objective}`);
    lines.push(`  - taskTokens: ${item.taskTokens}, taskUnproven: ${item.taskUnproven}, rebootstrapDuringObjective: ${item.rebootstrapDuringObjective}`);
    item.proofs.forEach((p, i) => {
      lines.push(`  - prove_claims #${i + 1}: status=${p.status}, evidenceCount=${p.evidenceCount}, evidenceIds=${(p.evidenceIds || []).join(', ')}`);
    });
  }
  lines.push('');

  lines.push('## 3) Drift enforcement');
  lines.push(`- Indexed new file: ${report.step3.indexedOk}`);
  lines.push(`- Old contract blocked with BOOTSTRAP_REQUIRED: ${report.step3.bootstrapRequired}`);
  lines.push(`- Block reasons: ${(report.step3.staleReasons || []).join(', ') || 'none'}`);
  lines.push(`- Re-bootstrap retry success: ${report.step3.retryOk}`);
  lines.push(`- Retry includes new file context: ${report.step3.retryIncludesNewFile}`);
  lines.push('');

  lines.push('## 4) DeltaPack since="last"');
  lines.push(`- Changed file included: ${report.step4.changedFileIncluded}`);
  lines.push(`- Changed files count: ${report.step4.changedFilesCount}`);
  lines.push(`- Affected flows count: ${report.step4.affectedFlowsCount}`);
  lines.push(`- Note: ${report.step4.note}`);
  lines.push('');

  lines.push('## 5) Proof-based code review comment for new file');
  report.step5.bullets.forEach((b, idx) => {
    if (b.cannotProve) {
      lines.push(`- ${idx + 1}. ${b.claimText} | cannot prove with current evidence`);
    } else {
      lines.push(`- ${idx + 1}. ${b.claimText} | evidenceIds: ${b.evidenceIds.join(', ')}`);
    }
  });
  lines.push('');

  lines.push('## Summary');
  lines.push('- Tool calls by type:');
  totalToolCalls.forEach(([name, count]) => lines.push(`  - ${name}: ${count}`));
  lines.push(`- Proving stats: requested=${report.proving.requested}, executed=${report.proving.executed}, cache_hits=${report.proving.cacheHits}, proof_work_units_used=${report.proving.proofWorkUnitsUsed}`);

  const totalTokens = report.totals.bootTokens + report.totals.deltaTokens + report.totals.taskTokens;
  lines.push(`- Tokens: boot=${report.totals.bootTokens}, delta=${report.totals.deltaTokens}, taskpacks=${report.totals.taskTokens}, total=${totalTokens}`);
  lines.push(`- UNPROVEN counts (strict packs): ${report.totals.strictUnproven}`);

  const explainable = report.step3.retryIncludesNewFile && report.step4.changedFileIncluded;
  lines.push(`- New file retrieved and explainable: ${explainable}`);

  fs.writeFileSync(reportPath, lines.join('\n') + '\n', 'utf-8');

  await warnClient.close();
  await strictClient.close();
  console.log(`Self-test completed. Report: ${reportPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
