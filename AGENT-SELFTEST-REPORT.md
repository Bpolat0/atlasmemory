# AGENT SELFTEST REPORT

Session: selftest
Generated: 2026-02-19T02:25:38.991Z

## 0) Contract/bootstrap discipline
- Initial reasons: DB_CHANGED, COVERAGE_LOW
- Initial isStale/shouldBlock: true / false
- Acknowledged contract: true
- Post-bootstrap reasons: COVERAGE_LOW
- Post-bootstrap isStale/shouldBlock: true / false

## 1) Cold-start explanation (BootPack only, strict)
- 1. C:AtlasMemory provides local-first repository memory with evidence-backed retrieval and task-focused context packs. | evidenceIds: f6ed51af-dff2-4da4-bd5d-615fe240d776, 3886786c-a0d4-4262-a33d-170c49476500, 5cd91d7b-67fb-4aad-85c4-af94a6293585
- 2. C:P1 (@atlasmemory/core) defines shared cards, refs, anchors, and flow types | evidenceIds: 13356ce0-e6e5-4c5f-a6e8-7077cf25834c
- 3. C:P2 (@atlasmemory/indexer) parses TS/Python and extracts symbols, anchors, imports, and calls | evidenceIds: c590de43-f9c6-4cae-8be4-6cc0d8ad01d8, 2717a25d-1cae-4658-b688-1636d6eb50f4, f6ed51af-dff2-4da4-bd5d-615fe240d776
- 4. C:P3 (@atlasmemory/store) persists files/symbols/cards/flows in SQLite with FTS | evidenceIds: c590de43-f9c6-4cae-8be4-6cc0d8ad01d8
- 5. C:P4 (@atlasmemory/retrieval) runs search with FTS and fallback ranking | evidenceIds: 1703769b-a46f-4e19-b28c-78af3980c24a, f6ed51af-dff2-4da4-bd5d-615fe240d776, 3886786c-a0d4-4262-a33d-170c49476500
- 6. C:P5 (@atlasmemory/taskpack) builds budgeted context packs for objectives | evidenceIds: df536151-563b-46e9-990b-c76437747421

## 2) Objectives (TaskPack strict + prove_claims)
- Objective: Trace ContextContractService evaluate flow and stale detection logic
  - taskTokens: 2208, taskUnproven: 0, rebootstrapDuringObjective: false
  - prove_claims #1: status=PROVEN, evidenceCount=3, evidenceIds=5cd91d7b-67fb-4aad-85c4-af94a6293585, 2001c4a3-7df9-49fa-8f37-e0d13106be7f, 74035577-93be-44c4-b971-f78aa389ac54
  - prove_claims #2: status=PROVEN, evidenceCount=3, evidenceIds=5cd91d7b-67fb-4aad-85c4-af94a6293585, 2001c4a3-7df9-49fa-8f37-e0d13106be7f, 74035577-93be-44c4-b971-f78aa389ac54
- Objective: Explain session bootstrap output contractHash/dbSig handling path
  - taskTokens: 2207, taskUnproven: 0, rebootstrapDuringObjective: false
  - prove_claims #1: status=PROVEN, evidenceCount=3, evidenceIds=5cd91d7b-67fb-4aad-85c4-af94a6293585, 2001c4a3-7df9-49fa-8f37-e0d13106be7f, 74035577-93be-44c4-b971-f78aa389ac54
  - prove_claims #2: status=PROVEN, evidenceCount=3, evidenceIds=5cd91d7b-67fb-4aad-85c4-af94a6293585, 2001c4a3-7df9-49fa-8f37-e0d13106be7f, 74035577-93be-44c4-b971-f78aa389ac54
- Objective: Review taskpack strict proof behavior and UNPROVEN suppression
  - taskTokens: 2207, taskUnproven: 0, rebootstrapDuringObjective: false
  - prove_claims #1: status=PROVEN, evidenceCount=3, evidenceIds=2001c4a3-7df9-49fa-8f37-e0d13106be7f, 5cd91d7b-67fb-4aad-85c4-af94a6293585, 74035577-93be-44c4-b971-f78aa389ac54
  - prove_claims #2: status=PROVEN, evidenceCount=3, evidenceIds=2001c4a3-7df9-49fa-8f37-e0d13106be7f, 5cd91d7b-67fb-4aad-85c4-af94a6293585, 74035577-93be-44c4-b971-f78aa389ac54

## 3) Drift enforcement
- Indexed new file: true
- Old contract blocked with BOOTSTRAP_REQUIRED: true
- Block reasons: DB_CHANGED, COVERAGE_LOW, CONTRACT_MISMATCH
- Re-bootstrap retry success: true
- Retry includes new file context: true

## 4) DeltaPack since="last"
- Changed file included: true
- Changed files count: 1
- Affected flows count: 1
- Note: Affected flows detected.

## 5) Proof-based code review comment for new file
- 1. The file exports __selftestDriftValue as a deterministic pure function | evidenceIds: 5c32cfa1-87d5-423f-a377-c7ab28bf6464
- 2. The function performs arithmetic and has no side effects | evidenceIds: 5c32cfa1-87d5-423f-a377-c7ab28bf6464
- 3. The file also exports __selftestDriftTouched constant | evidenceIds: 5c32cfa1-87d5-423f-a377-c7ab28bf6464
- 4. The file follows project TypeScript module style | evidenceIds: 5c32cfa1-87d5-423f-a377-c7ab28bf6464
- 5. The file is indexed and retrievable through AtlasMemory search graph | evidenceIds: 5c32cfa1-87d5-423f-a377-c7ab28bf6464

## Summary
- Tool calls by type:
  - acknowledge_context(warn): 2
  - build_task_pack(strict): 1
  - build_task_pack(warn): 4
  - deltapack(warn): 2
  - get_context_contract(warn): 2
  - index_file(warn): 2
  - prove_claims(warn): 4
  - session_bootstrap(warn): 2
- Proving stats: requested=11, executed=0, cache_hits=11, proof_work_units_used=0
- Tokens: boot=2098, delta=651, taskpacks=8823, total=11572
- UNPROVEN counts (strict packs): 0
- New file retrieved and explainable: true
