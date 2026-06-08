const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

async function main() {
  const SQL = await initSqlJs();
  const dbPath = path.join(__dirname, '..', 'workflow-data', 'workflow.db');
  if (!fs.existsSync(dbPath)) {
    console.error('No workflow.db found at', dbPath);
    process.exit(1);
  }
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);

  const tablesRes = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
  const tableNames = new Set((tablesRes[0]?.values ?? []).map(r => r[0]));
  console.log('Tables in DB:', Array.from(tableNames).join(', '));

  if (!tableNames.has('nodes')) {
    console.log('nodes table missing; creating workflow tables: nodes, node_executions, edges (idempotent)');
    const sql = `
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    node_type TEXT NOT NULL,
    position_x REAL NOT NULL,
    position_y REAL NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    current_output_id TEXT,
    parent_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
    FOREIGN KEY (current_output_id) REFERENCES node_executions(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS node_executions (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    input_hash TEXT NOT NULL,
    params_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'error')),
    result_path TEXT,
    result_metadata TEXT,
    duration_ms INTEGER,
    cost REAL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    score REAL,
    starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0, 1))
);
CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    source_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    source_output_key TEXT NOT NULL,
    target_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target_input_key TEXT NOT NULL,
    is_internal INTEGER NOT NULL DEFAULT 0 CHECK (is_internal IN (0, 1)),
    UNIQUE(source_node_id, source_output_key, target_node_id, target_input_key)
);
CREATE INDEX IF NOT EXISTS idx_wf_nodes_workflow ON nodes(workflow_id);
CREATE INDEX IF NOT EXISTS idx_wf_edges_workflow ON edges(workflow_id);
CREATE INDEX IF NOT EXISTS idx_wf_executions_node ON node_executions(node_id);
CREATE INDEX IF NOT EXISTS idx_wf_executions_workflow ON node_executions(workflow_id);
CREATE INDEX IF NOT EXISTS idx_wf_executions_created ON node_executions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wf_executions_cache ON node_executions(node_id, input_hash, params_hash, status);
CREATE INDEX IF NOT EXISTS idx_wf_edges_source ON edges(source_node_id);
CREATE INDEX IF NOT EXISTS idx_wf_edges_target ON edges(target_node_id);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_internal ON edges(is_internal);
`;
    try {
      db.run(sql);
      const out = db.export();
      fs.writeFileSync(dbPath, Buffer.from(out));
      console.log('Workflow DB updated and saved.');
    } catch (err) {
      console.error('Failed to update workflow DB:', err);
      process.exit(1);
    }
  } else {
    console.log('nodes table exists; no changes made.');
  }
  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
