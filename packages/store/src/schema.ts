export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    language TEXT,
    content_hash TEXT,
    loc INTEGER,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS symbols (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT,
    signature TEXT,
    visibility TEXT,
    start_line INTEGER,
    end_line INTEGER,
    signature_hash TEXT,
    FOREIGN KEY(file_id) REFERENCES files(id)
  );

  CREATE TABLE IF NOT EXISTS imports (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    imported_module TEXT NOT NULL,
    imported_symbol TEXT,
    resolved_file_id TEXT,
    is_external INTEGER,
    FOREIGN KEY(file_id) REFERENCES files(id),
    FOREIGN KEY(resolved_file_id) REFERENCES files(id)
  );

  CREATE TABLE IF NOT EXISTS refs (
    id TEXT PRIMARY KEY,
    from_symbol_id TEXT NOT NULL,
    to_symbol_id TEXT,
    to_name TEXT,
    ref_kind TEXT,
    anchor_id TEXT,
    FOREIGN KEY(from_symbol_id) REFERENCES symbols(id),
    FOREIGN KEY(to_symbol_id) REFERENCES symbols(id)
  );

  CREATE TABLE IF NOT EXISTS anchors (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    start_line INTEGER,
    end_line INTEGER,
    snippet_hash TEXT,
    created_at TEXT,
    FOREIGN KEY(file_id) REFERENCES files(id)
  );

  CREATE TABLE IF NOT EXISTS file_cards (
    file_id TEXT PRIMARY KEY,
    card_level0 TEXT,
    card_level1 TEXT,
    card_level2 TEXT,
    evidence_anchors_json TEXT,
    card_hash TEXT,
    quality_score REAL DEFAULT 0,
    quality_flags_json TEXT,
    updated_at TEXT,
    FOREIGN KEY(file_id) REFERENCES files(id)
  );

  CREATE TABLE IF NOT EXISTS flow_cards (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    root_symbol_id TEXT,
    flow_kind TEXT NOT NULL,
    hop_count INTEGER NOT NULL,
    summary TEXT NOT NULL,
    trace_json TEXT NOT NULL,
    evidence_anchors_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(file_id) REFERENCES files(id),
    FOREIGN KEY(root_symbol_id) REFERENCES symbols(id)
  );

  CREATE TABLE IF NOT EXISTS project_card (
    id TEXT PRIMARY KEY,
    purpose TEXT NOT NULL,
    architecture_bullets_json TEXT NOT NULL,
    invariants_json TEXT NOT NULL,
    entrypoints_json TEXT NOT NULL,
    key_flows_json TEXT NOT NULL,
    tools_protocol_json TEXT NOT NULL,
    glossary_json TEXT NOT NULL,
    card_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session_state (
    state_key TEXT PRIMARY KEY,
    state_value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS context_snapshots (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    created_at TEXT NOT NULL,
    repo_id TEXT NOT NULL,
    git_head TEXT,
    db_sig_json TEXT NOT NULL,
    bootpack_hash TEXT,
    deltapack_hash TEXT,
    taskpack_hash TEXT,
    objective TEXT,
    budgets_json TEXT,
    proof_mode TEXT,
    min_db_coverage REAL,
    contract_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS folder_cards (
    folder_path TEXT PRIMARY KEY,
    card_level0 TEXT NOT NULL, 
    card_level1 TEXT, 
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS symbol_cards (
    symbol_id TEXT PRIMARY KEY,
    card_level0 TEXT NOT NULL,
    card_level1 TEXT,
    evidence_anchors_json TEXT,
    quality_score REAL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(symbol_id) REFERENCES symbols(id) ON DELETE CASCADE
  );
  
  CREATE TABLE IF NOT EXISTS reverse_refs (
    id TEXT PRIMARY KEY,
    to_symbol_id TEXT NOT NULL,
    from_symbol_id TEXT NOT NULL,
    from_file_id TEXT NOT NULL,
    ref_kind TEXT DEFAULT 'call',
    anchor_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_reverse_refs_to ON reverse_refs(to_symbol_id);
  CREATE INDEX IF NOT EXISTS idx_reverse_refs_from_file ON reverse_refs(from_file_id);

  CREATE TABLE IF NOT EXISTS conversation_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_data TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_conv_session ON conversation_events(session_id);
  CREATE INDEX IF NOT EXISTS idx_conv_type ON conversation_events(event_type);

  CREATE TABLE IF NOT EXISTS session_patterns (
    id TEXT PRIMARY KEY,
    pattern_type TEXT NOT NULL,
    pattern_key TEXT NOT NULL,
    pattern_data TEXT NOT NULL,
    frequency INTEGER DEFAULT 1,
    confidence REAL DEFAULT 0.5,
    last_seen TEXT DEFAULT (datetime('now')),
    UNIQUE(pattern_type, pattern_key)
  );
  CREATE INDEX IF NOT EXISTS idx_patterns_type ON session_patterns(pattern_type);
  CREATE INDEX IF NOT EXISTS idx_patterns_freq ON session_patterns(frequency DESC);

  CREATE TABLE IF NOT EXISTS token_usage (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    tokens_estimated INTEGER NOT NULL,
    budget_total INTEGER,
    budget_remaining INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_token_session ON token_usage(session_id);

  -- FTS Tables (Porter stemmer enables matching "authentication" ↔ "authenticate")
  CREATE VIRTUAL TABLE IF NOT EXISTS fts_files USING fts5(path, content, file_id UNINDEXED, tokenize='porter unicode61');
  CREATE VIRTUAL TABLE IF NOT EXISTS fts_symbols USING fts5(name, qualified_name, signature, file_id UNINDEXED, tokenize='porter unicode61');

  -- Phase 20: Semantic Tags FTS (AI-generated concept-level search)
  CREATE VIRTUAL TABLE IF NOT EXISTS fts_semantic_tags
    USING fts5(tags, intent, file_id UNINDEXED, tokenize='porter unicode61');

  -- Phase 20: Code Health (git history-based file health metrics)
  CREATE TABLE IF NOT EXISTS code_health (
    file_id TEXT PRIMARY KEY,
    churn_score REAL,
    break_frequency INTEGER DEFAULT 0,
    last_modified TEXT,
    contributor_count INTEGER DEFAULT 1,
    coupled_files_json TEXT,
    risk_level TEXT DEFAULT 'stable',
    analyzed_at TEXT,
    FOREIGN KEY (file_id) REFERENCES files(id)
  );
`;
