/**
 * Node repository — CRUD operations for nodes table.
 */
import { getDatabase, persistDatabase } from "./connection";
import type { WorkflowNode } from "../../../src/workflow/types/workflow";

const NODE_COLS =
  "id, workflow_id, node_type, position_x, position_y, params, current_output_id, parent_node_id";

function rowToNode(row: unknown[]): WorkflowNode {
  return {
    id: row[0] as string,
    workflowId: row[1] as string,
    nodeType: row[2] as string,
    position: { x: row[3] as number, y: row[4] as number },
    params: JSON.parse(row[5] as string),
    currentOutputId: row[6] as string | null,
    parentNodeId: (row[7] as string | null) ?? null,
  };
}

export function getNodesByWorkflowId(workflowId: string): WorkflowNode[] {
  const db = getDatabase();
  const result = db.exec(
    `SELECT ${NODE_COLS} FROM nodes WHERE workflow_id = ?`,
    [workflowId],
  );
  if (!result.length) return [];
  return result[0].values.map(rowToNode);
}

export function getChildNodes(parentNodeId: string): WorkflowNode[] {
  const db = getDatabase();
  const result = db.exec(
    `SELECT ${NODE_COLS} FROM nodes WHERE parent_node_id = ?`,
    [parentNodeId],
  );
  if (!result.length) return [];
  return result[0].values.map(rowToNode);
}

export function updateNodeParams(
  nodeId: string,
  params: Record<string, unknown>,
): void {
  const db = getDatabase();
  db.run("UPDATE nodes SET params = ? WHERE id = ?", [
    JSON.stringify(params),
    nodeId,
  ]);
  persistDatabase();
}

export function updateNodeCurrentOutputId(
  nodeId: string,
  executionId: string | null,
): void {
  const db = getDatabase();
  db.run("UPDATE nodes SET current_output_id = ? WHERE id = ?", [
    executionId,
    nodeId,
  ]);
  persistDatabase();
}
