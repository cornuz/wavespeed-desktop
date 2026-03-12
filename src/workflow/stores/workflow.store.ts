/**
 * Workflow Zustand store — manages canvas nodes, edges, and workflow metadata.
 * Includes snapshot-based undo/redo (Ctrl+Z / Ctrl+Shift+Z).
 */
import { create } from "zustand";
import {
  type Node as ReactFlowNode,
  type Edge as ReactFlowEdge,
  type Connection,
  type XYPosition,
  type NodeChange,
  type EdgeChange,
  applyNodeChanges,
  applyEdgeChanges,
} from "reactflow";
import { v4 as uuid } from "uuid";
import { workflowIpc, registryIpc } from "../ipc/ipc-client";
import type { WorkflowNode, WorkflowEdge, ExposedParam } from "@/workflow/types/workflow";
import type { PortDefinition } from "@/workflow/types/node-defs";
import { wouldCreateCycleInSubWorkflow } from "@/workflow/lib/cycle-detection";

/* ── Iterator bounding-box constants ──────────────────────────────── */
const MIN_ITERATOR_WIDTH = 600;
const MIN_ITERATOR_HEIGHT = 400;
const CHILD_PADDING = 40;
const PORT_STRIP_WIDTH = 140;

/** Lazy getter to avoid circular import with execution.store */
function getActiveExecutions(): Set<string> {
  try {
    // Dynamic import resolved at runtime, not at module load
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("./execution.store");
    const executionStore = resolveStoreExport<{
      activeExecutions: Set<string>;
    }>(mod, "useExecutionStore");
    return executionStore?.getState().activeExecutions ?? new Set();
  } catch {
    return new Set();
  }
}

type StoreWithGetState<TState> = {
  getState: () => TState;
};

function resolveStoreExport<TState>(
  mod: unknown,
  name: string,
): StoreWithGetState<TState> | null {
  if (!mod || typeof mod !== "object") return null;
  const moduleObj = mod as Record<string, unknown>;
  const direct = moduleObj[name] as StoreWithGetState<TState> | undefined;
  if (direct && typeof direct.getState === "function") return direct;

  const defaultExport = moduleObj.default as
    | Record<string, unknown>
    | undefined;
  if (!defaultExport || typeof defaultExport !== "object") return null;

  const nested = defaultExport[name] as StoreWithGetState<TState> | undefined;
  if (nested && typeof nested.getState === "function") return nested;

  const defaultStore = defaultExport as unknown as StoreWithGetState<TState>;
  if (typeof defaultStore.getState === "function") return defaultStore;

  return null;
}

/* ── Default content for new workflows ─────────────────────────────────── */

const DEFAULT_NEW_WORKFLOW_MODEL = "bytedance/seedream-v4.5";
const DEFAULT_NEW_WORKFLOW_PROMPT =
  "An ethereal female elf with long platinum-blonde hair and pointed ears, wearing an elegant dress made of leaves and vines. She stands barefoot in an ancient forest illuminated by magical light spots, one hand gently touching a glowing mushroom. Her expression is otherworldly and curious. Dreamy soft focus, Tyndall effect light beams filtering through the canopy, magical realism photography.";

/** Returns one AI task node (and no edges) for a new workflow. */
export function getDefaultNewWorkflowContent(): {
  nodes: ReactFlowNode[];
  edges: ReactFlowEdge[];
} {
  const nodeId = uuid();
  return {
    nodes: [
      {
        id: nodeId,
        type: "custom",
        position: { x: 120, y: 120 },
        data: {
          nodeType: "ai-task/run",
          params: {
            modelId: DEFAULT_NEW_WORKFLOW_MODEL,
            prompt: DEFAULT_NEW_WORKFLOW_PROMPT,
          },
          label: "",
          paramDefinitions: [],
          inputDefinitions: [],
          outputDefinitions: [],
        },
      },
    ],
    edges: [],
  };
}

/* ── Undo / Redo history (snapshot-based) ──────────────────────────────── */

const MAX_UNDO = 50;

interface Snapshot {
  nodes: ReactFlowNode[];
  edges: ReactFlowEdge[];
}

let undoStack: Snapshot[] = [];
let redoStack: Snapshot[] = [];

function pushUndo(s: Snapshot) {
  undoStack = [...undoStack.slice(-(MAX_UNDO - 1)), s];
  redoStack = []; // any new change clears redo
}

/** Time-debounced undo push — avoids creating a snapshot on every keystroke
 *  during rapid text editing (especially CJK IME input). */
let _lastUndoPushTime = 0;
const UNDO_DEBOUNCE_MS = 600;

function pushUndoDebounced(s: Snapshot) {
  const now = Date.now();
  if (now - _lastUndoPushTime > UNDO_DEBOUNCE_MS) {
    pushUndo(s);
    _lastUndoPushTime = now;
  }
}

/** Snapshot captured at the start of a node drag — pushed to undo when drag ends. */
let _dragStartSnapshot: Snapshot | null = null;

/* ── Save concurrency guard ────────────────────────────────────────────── */
let _saveInProgress = false;

export interface SaveWorkflowOptions {
  /** When true, untitled workflows are saved with an auto-generated name instead of prompting. */
  forRun?: boolean;
}

/** Internal save implementation — extracted so the concurrency guard stays clean. */
async function _doSaveWorkflow(
  get: () => WorkflowState,
  set: (partial: Partial<WorkflowState>) => void,
  options?: SaveWorkflowOptions,
) {
  let { workflowId } = get();
  const { workflowName, nodes, edges } = get();

  // Don't save unnamed workflows — prompt user for a name via UI dialog (unless saving for run)
  const isUntitled =
    !workflowName || /^Untitled Workflow(\s+\d+)?$/.test(workflowName);
  if (isUntitled) {
    if (options?.forRun) {
      // Auto-generate a name so Run Workflow never requires naming
      const autoName = `Workflow ${new Date().toISOString().slice(0, 19).replace("T", " ")}`;
      set({ workflowName: autoName });
    } else {
      const uiStoreModule = await import("./ui.store");
      const uiStore = resolveStoreExport<{
        promptWorkflowName: (
          defaultName?: string,
        ) => Promise<{ name: string; overwriteId?: string } | null>;
      }>(uiStoreModule, "useUIStore");
      const promptWorkflowName = uiStore?.getState().promptWorkflowName;
      if (typeof promptWorkflowName !== "function") {
        throw new Error("Workflow naming dialog is unavailable");
      }
      const result = await promptWorkflowName(workflowName || "");
      if (
        !result ||
        !result.name.trim() ||
        /^Untitled Workflow(\s+\d+)?$/.test(result.name.trim())
      )
        return;
      set({ workflowName: result.name.trim() });
      // If user chose to overwrite an existing workflow, use that workflow's ID
      if (result.overwriteId) {
        workflowId = result.overwriteId;
        set({ workflowId: result.overwriteId });
      }
    }
  }

  let finalName = get().workflowName;

  // Session restore may carry a stale workflowId (e.g. after reinstall or DB path migration).
  // Validate it before save; if not found, create a new workflow on this save.
  if (workflowId) {
    try {
      await workflowIpc.load(workflowId);
    } catch {
      workflowId = null;
      set({ workflowId: null });
    }
  }

  // Auto-create workflow on first save (lazy creation)
  if (!workflowId) {
    if (nodes.length === 0) return;
    const wf = await workflowIpc.create({ name: finalName });
    workflowId = wf.id;
    // Use the actual name returned by create (may have been deduplicated)
    finalName = wf.name;
    set({ workflowId: wf.id, workflowName: wf.name });
  }

  const wfNodes: WorkflowNode[] = nodes.map((n) => ({
    id: n.id,
    workflowId: workflowId!,
    nodeType: n.data.nodeType,
    position: n.position,
    params: {
      ...(n.data.params ?? {}),
      __meta: {
        label: n.data.label,
        modelInputSchema: n.data.modelInputSchema ?? [],
      },
    },
    currentOutputId: null, // placeholder — repo will preserve existing DB value
    parentNodeId: n.parentNode ?? null,
  }));

  const wfEdges: WorkflowEdge[] = edges.map((e) => ({
    id: e.id,
    workflowId: workflowId!,
    sourceNodeId: e.source,
    sourceOutputKey: e.sourceHandle ?? "output",
    targetNodeId: e.target,
    targetInputKey: e.targetHandle ?? "input",
    isInternal: e.data?.isInternal === true,
  }));

  await workflowIpc.save({
    id: workflowId!,
    name: finalName,
    nodes: wfNodes,
    edges: wfEdges,
  });
  // Sync name back — backend may have deduplicated it
  try {
    const saved = await workflowIpc.load(workflowId!);
    if (saved.name !== finalName) {
      set({ workflowName: saved.name });
    }
  } catch {
    /* ignore */
  }
  set({ isDirty: false });
}

/* ── Store ─────────────────────────────────────────────────────────────── */

export interface WorkflowState {
  nodes: ReactFlowNode[];
  edges: ReactFlowEdge[];
  workflowId: string | null;
  workflowName: string;
  isDirty: boolean;
  canUndo: boolean;
  canRedo: boolean;

  addNode: (
    type: string,
    position: XYPosition,
    defaultParams?: Record<string, unknown>,
    label?: string,
    paramDefs?: unknown[],
    inputDefs?: unknown[],
    outputDefs?: unknown[],
  ) => string;
  removeNode: (nodeId: string) => void;
  removeNodes: (nodeIds: string[]) => void;
  duplicateNode: (nodeId: string) => string;
  addEdge: (connection: Connection) => void;
  updateEdge: (oldEdge: ReactFlowEdge, newConnection: Connection) => void;
  removeEdge: (edgeId: string) => void;
  removeEdgesByIds: (edgeIds: string[]) => void;
  updateNodeParams: (nodeId: string, params: Record<string, unknown>) => void;
  updateNodeData: (nodeId: string, data: Record<string, unknown>) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  undo: () => void;
  redo: () => void;
  saveWorkflow: (options?: SaveWorkflowOptions) => Promise<void>;
  loadWorkflow: (id: string) => Promise<void>;
  newWorkflow: (name: string) => Promise<void>;
  setWorkflowName: (name: string) => void;
  renameWorkflow: (newName: string) => Promise<void>;
  adoptNode: (iteratorId: string, childId: string) => void;
  releaseNode: (iteratorId: string, childId: string) => void;
  updateBoundingBox: (iteratorId: string) => void;
  exposeParam: (iteratorId: string, param: ExposedParam) => void;
  unexposeParam: (iteratorId: string, namespacedKey: string, direction: "input" | "output") => void;
  reset: () => void;
}

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  nodes: [],
  edges: [],
  workflowId: null,
  workflowName: "Untitled Workflow",
  isDirty: false,
  canUndo: false,
  canRedo: false,

  addNode: (
    type,
    position,
    defaultParams = {},
    label,
    paramDefs = [],
    inputDefs = [],
    outputDefs = [],
  ) => {
    const { nodes, edges, workflowId } = get();
    pushUndo({ nodes, edges });
    const id = uuid();
    const newNode: ReactFlowNode = {
      id,
      type: type === "control/iterator" ? "control/iterator" : "custom",
      position,
      data: {
        nodeType: type,
        params: defaultParams,
        label: label ?? type,
        paramDefinitions: paramDefs,
        inputDefinitions: inputDefs,
        outputDefinitions: outputDefs,
      },
    };
    set((state) => ({
      nodes: [...state.nodes, newNode],
      isDirty: true,
      canUndo: true,
      canRedo: false,
    }));

    // Only auto-save if workflow already exists; don't auto-create on node add
    if (workflowId) {
      setTimeout(() => {
        get().saveWorkflow().catch(console.error);
      }, 100);
    }
    return id;
  },

  removeNode: (nodeId) => {
    // Guard: prevent deleting a running node
    if (getActiveExecutions().has(nodeId)) {
      alert("Cannot delete a running node. Cancel execution first.");
      return;
    }
    const { nodes, edges } = get();
    pushUndo({ nodes, edges });
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== nodeId),
      edges: state.edges.filter(
        (e) => e.source !== nodeId && e.target !== nodeId,
      ),
      isDirty: true,
      canUndo: true,
      canRedo: false,
    }));
  },

  removeNodes: (nodeIds) => {
    if (nodeIds.length === 0) return;
    const activeExecs = getActiveExecutions();
    const blocked = nodeIds.filter((id) => activeExecs.has(id));
    if (blocked.length > 0) {
      alert("Cannot delete running nodes. Cancel execution first.");
      return;
    }
    const { nodes, edges } = get();
    pushUndo({ nodes, edges });
    const removeSet = new Set(nodeIds);
    set((state) => ({
      nodes: state.nodes.filter((n) => !removeSet.has(n.id)),
      edges: state.edges.filter(
        (e) => !removeSet.has(e.source) && !removeSet.has(e.target),
      ),
      isDirty: true,
      canUndo: true,
      canRedo: false,
    }));
  },

  duplicateNode: (nodeId) => {
    const state = get();
    const orig = state.nodes.find((n) => n.id === nodeId);
    if (!orig) return "";
    pushUndo({ nodes: state.nodes, edges: state.edges });
    const id = uuid();
    const newNode: ReactFlowNode = {
      ...orig,
      id,
      position: { x: orig.position.x + 50, y: orig.position.y + 50 },
      data: { ...orig.data, params: { ...orig.data.params } },
    };
    set((state) => ({
      nodes: [...state.nodes, newNode],
      isDirty: true,
      canUndo: true,
      canRedo: false,
    }));
    return id;
  },

  addEdge: (connection) => {
    if (!connection.source || !connection.target) return;
    // Guard: no self-connections
    if (connection.source === connection.target) return;
    const { nodes, edges } = get();
    // Guard: no duplicate connections (same source handle → same target handle)
    const duplicate = edges.some(
      (e) =>
        e.source === connection.source &&
        e.target === connection.target &&
        e.sourceHandle === (connection.sourceHandle ?? "output") &&
        e.targetHandle === (connection.targetHandle ?? "input"),
    );
    if (duplicate) return;

    // ── Sub-workflow cycle detection ──
    // If both source and target are inside the same Iterator, validate that
    // the new edge won't create a cycle within the sub-workflow.
    const sourceNode = nodes.find((n) => n.id === connection.source);
    const targetNode = nodes.find((n) => n.id === connection.target);
    const isInternal =
      sourceNode?.parentNode &&
      targetNode?.parentNode &&
      sourceNode.parentNode === targetNode.parentNode;

    if (isInternal) {
      const parentId = sourceNode!.parentNode!;
      const subNodeIds = nodes
        .filter((n) => n.parentNode === parentId)
        .map((n) => n.id);
      const internalEdges = edges
        .filter(
          (e) =>
            e.data?.isInternal &&
            subNodeIds.includes(e.source) &&
            subNodeIds.includes(e.target),
        )
        .map((e) => ({ sourceNodeId: e.source, targetNodeId: e.target }));

      const wouldCycle = wouldCreateCycleInSubWorkflow(
        subNodeIds,
        internalEdges,
        { sourceNodeId: connection.source, targetNodeId: connection.target },
      );
      if (wouldCycle) {
        // Reject the connection — dispatch a toast event for the UI
        window.dispatchEvent(
          new CustomEvent("workflow:toast", {
            detail: {
              type: "error",
              msg: "Cannot connect: this would create a cycle inside the Iterator",
            },
          }),
        );
        return;
      }
    }

    // Guard: a target handle can only have one incoming connection
    const targetHandle = connection.targetHandle ?? "input";
    const existingToTarget = edges.some(
      (e) => e.target === connection.target && e.targetHandle === targetHandle,
    );
    if (existingToTarget) {
      // Replace the existing connection
      const filtered = edges.filter(
        (e) =>
          !(e.target === connection.target && e.targetHandle === targetHandle),
      );
      pushUndo({ nodes, edges });
      const id = uuid();
      const newEdge: ReactFlowEdge = {
        id,
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle ?? "output",
        targetHandle,
        type: "custom",
        ...(isInternal ? { data: { isInternal: true } } : {}),
      };
      set({
        edges: [...filtered, newEdge],
        isDirty: true,
        canUndo: true,
        canRedo: false,
      });
    } else {
      pushUndo({ nodes, edges });
      const id = uuid();
      const newEdge: ReactFlowEdge = {
        id,
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle ?? "output",
        targetHandle,
        type: "custom",
        ...(isInternal ? { data: { isInternal: true } } : {}),
      };
      set((state) => ({
        edges: [...state.edges, newEdge],
        isDirty: true,
        canUndo: true,
        canRedo: false,
      }));
    }
    setTimeout(() => {
      const state = get();
      if (state.workflowId) state.saveWorkflow().catch(console.error);
    }, 100);
  },

  updateEdge: (oldEdge, newConnection) => {
    if (!newConnection.source || !newConnection.target) return;
    if (newConnection.source === newConnection.target) return;
    const newSource = newConnection.source;
    const newTarget = newConnection.target;
    const { nodes, edges } = get();
    const sourceHandle = newConnection.sourceHandle ?? "output";
    const targetHandle = newConnection.targetHandle ?? "input";
    // Guard: no duplicate connections
    const duplicate = edges.some(
      (e) =>
        e.id !== oldEdge.id &&
        e.source === newSource &&
        e.target === newTarget &&
        e.sourceHandle === sourceHandle &&
        e.targetHandle === targetHandle,
    );
    if (duplicate) return;
    // Guard: target handle can only have one incoming connection (except from the same edge being updated)
    const existingToTarget = edges.some(
      (e) =>
        e.id !== oldEdge.id &&
        e.target === newTarget &&
        e.targetHandle === targetHandle,
    );
    if (existingToTarget) {
      // Replace the conflicting edge
      const filtered = edges.filter(
        (e) =>
          e.id !== oldEdge.id &&
          !(e.target === newTarget && e.targetHandle === targetHandle),
      );
      pushUndo({ nodes, edges });
      set({
        edges: [
          ...filtered,
          {
            id: oldEdge.id,
            source: newSource,
            target: newTarget,
            sourceHandle,
            targetHandle,
            type: "custom",
          },
        ],
        isDirty: true,
        canUndo: true,
        canRedo: false,
      });
    } else {
      pushUndo({ nodes, edges });
      set({
        edges: edges.map((e) =>
          e.id === oldEdge.id
            ? {
                id: e.id,
                source: newSource,
                target: newTarget,
                sourceHandle,
                targetHandle,
                type: "custom",
              }
            : e,
        ),
        isDirty: true,
        canUndo: true,
        canRedo: false,
      });
    }
    setTimeout(() => {
      const state = get();
      if (state.workflowId) state.saveWorkflow().catch(console.error);
    }, 100);
  },

  removeEdge: (edgeId) => {
    const { nodes, edges } = get();
    pushUndo({ nodes, edges });
    set((state) => ({
      edges: state.edges.filter((e) => e.id !== edgeId),
      isDirty: true,
      canUndo: true,
      canRedo: false,
    }));
  },

  removeEdgesByIds: (edgeIds) => {
    if (edgeIds.length === 0) return;
    const { nodes, edges } = get();
    pushUndo({ nodes, edges });
    const removeSet = new Set(edgeIds);
    set((state) => ({
      edges: state.edges.filter((e) => !removeSet.has(e.id)),
      isDirty: true,
      canUndo: true,
      canRedo: false,
    }));
  },

  updateNodeParams: (nodeId, params) => {
    const { nodes, edges } = get();
    pushUndoDebounced({ nodes, edges });
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, params } } : n,
      ),
      isDirty: true,
      canUndo: true,
      canRedo: false,
    }));

    // If this node is a child of an Iterator, recalculate the bounding box
    // so the Iterator auto-expands when child node size changes
    const node = nodes.find((n) => n.id === nodeId);
    if (node?.parentNode) {
      get().updateBoundingBox(node.parentNode);
    }
  },

  updateNodeData: (nodeId, dataUpdate) => {
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, ...dataUpdate } } : n,
      ),
      isDirty: true,
    }));
  },

  onNodesChange: (changes) => {
    // Structural changes (add/remove) always push undo immediately
    const isStructural = changes.some(
      (c) => c.type === "remove" || c.type === "add",
    );
    if (isStructural) {
      const { nodes, edges } = get();
      pushUndo({ nodes, edges });
    }

    // Track node drag: capture snapshot at drag start, push undo at drag end
    const posChanges = changes.filter(
      (c): c is NodeChange & { type: "position"; dragging?: boolean } =>
        c.type === "position",
    );
    if (posChanges.length > 0) {
      const anyDragging = posChanges.some((c) => c.dragging === true);
      const anyDragEnd = posChanges.some((c) => c.dragging === false);

      if (anyDragging && !_dragStartSnapshot) {
        // Drag just started — capture current state before positions change
        const { nodes, edges } = get();
        _dragStartSnapshot = { nodes, edges };
      }
      if (anyDragEnd && _dragStartSnapshot) {
        // Drag ended — push the pre-drag snapshot to undo stack
        pushUndo(_dragStartSnapshot);
        _dragStartSnapshot = null;
      }
    }

    set((state) => ({
      nodes: applyNodeChanges(changes, state.nodes),
      isDirty: true,
      ...(isStructural || posChanges.some((c) => c.dragging === false)
        ? { canUndo: true, canRedo: false }
        : {}),
    }));

    // NOTE: We intentionally do NOT call updateBoundingBox on position changes.
    // The iterator border should only expand when child nodes are added or their
    // UI size changes (e.g. model switch), not when dragging children around.
    // Children are clamped within the iterator bounds by useIteratorAdoption.
  },

  onEdgesChange: (changes) => {
    const isStructural = changes.some(
      (c) => c.type === "remove" || c.type === "add",
    );
    if (isStructural) {
      const { nodes, edges } = get();
      pushUndo({ nodes, edges });
    }
    set((state) => ({
      edges: applyEdgeChanges(changes, state.edges),
      isDirty: true,
      ...(isStructural ? { canUndo: true, canRedo: false } : {}),
    }));
  },

  undo: () => {
    if (undoStack.length === 0) return;
    const { nodes, edges } = get();
    redoStack = [...redoStack, { nodes, edges }];
    const prev = undoStack[undoStack.length - 1];
    undoStack = undoStack.slice(0, -1);
    set({
      nodes: prev.nodes,
      edges: prev.edges,
      isDirty: true,
      canUndo: undoStack.length > 0,
      canRedo: true,
    });
  },

  redo: () => {
    if (redoStack.length === 0) return;
    const { nodes, edges } = get();
    undoStack = [...undoStack, { nodes, edges }];
    const next = redoStack[redoStack.length - 1];
    redoStack = redoStack.slice(0, -1);
    set({
      nodes: next.nodes,
      edges: next.edges,
      isDirty: true,
      canUndo: true,
      canRedo: redoStack.length > 0,
    });
  },

  saveWorkflow: async (options) => {
    // Prevent concurrent saves — two overlapping calls can both see workflowId=null
    // and each create a separate workflow, resulting in duplicates.
    if (_saveInProgress) return;
    _saveInProgress = true;
    try {
      await _doSaveWorkflow(get, set, options);
    } finally {
      _saveInProgress = false;
    }
  },

  loadWorkflow: async (id) => {
    const wf = await workflowIpc.load(id);
    let defMap = new Map<
      string,
      {
        params: unknown[];
        inputs: unknown[];
        outputs: unknown[];
        label: string;
      }
    >();
    try {
      const defs = await registryIpc.getAll();
      defMap = new Map(
        defs.map((def) => [
          def.type,
          {
            params: def.params ?? [],
            inputs: def.inputs ?? [],
            outputs: def.outputs ?? [],
            label: def.label ?? def.type,
          },
        ]),
      );
    } catch {
      // Keep empty map as fallback; nodes still load with persisted params.
    }

    // Build a map of iteratorId → childNodeIds from parent relationships
    const iteratorChildMap = new Map<string, string[]>();
    for (const n of wf.graphDefinition.nodes) {
      if (n.parentNodeId) {
        const children = iteratorChildMap.get(n.parentNodeId) ?? [];
        children.push(n.id);
        iteratorChildMap.set(n.parentNodeId, children);
      }
    }

    const rfNodes: ReactFlowNode[] = wf.graphDefinition.nodes.map((n) => {
      // Restore modelInputSchema and label from saved params metadata
      const meta = (n.params as Record<string, unknown>).__meta as
        | Record<string, unknown>
        | undefined;
      const modelInputSchema = meta?.modelInputSchema as unknown[] | undefined;
      const def = defMap.get(n.nodeType);
      const label = (meta?.label as string) || (def ? def.label : n.nodeType);
      // Strip __meta from the params passed to the node
      const { __meta: _, ...cleanParams } = n.params as Record<string, unknown>;

      const isIterator = n.nodeType === "control/iterator";
      const rfNode: ReactFlowNode = {
        id: n.id,
        type: isIterator ? "control/iterator" : "custom",
        position: n.position,
        data: {
          nodeType: n.nodeType,
          params: cleanParams,
          label,
          modelInputSchema: modelInputSchema ?? [],
          paramDefinitions: def?.params ?? [],
          inputDefinitions: def?.inputs ?? [],
          outputDefinitions: def?.outputs ?? [],
          ...(isIterator
            ? { childNodeIds: iteratorChildMap.get(n.id) ?? [] }
            : {}),
        },
      };

      // Restore parent-child relationship for sub-nodes
      if (n.parentNodeId) {
        rfNode.parentNode = n.parentNodeId;
        rfNode.extent = "parent" as const;
      }

      return rfNode;
    });
    const rfEdges: ReactFlowEdge[] = wf.graphDefinition.edges.map((e) => ({
      id: e.id,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      sourceHandle: e.sourceOutputKey,
      targetHandle: e.targetInputKey,
      type: "custom",
      ...(e.isInternal ? { data: { isInternal: true } } : {}),
    }));
    set({
      workflowId: wf.id,
      workflowName: wf.name,
      nodes: rfNodes,
      edges: rfEdges,
      isDirty: false,
    });

    // Recalculate bounding boxes for all iterator nodes
    for (const iteratorId of iteratorChildMap.keys()) {
      get().updateBoundingBox(iteratorId);
    }

    // Restore previous execution results for all nodes
    try {
      const executionStoreModule = await import("./execution.store");
      const executionStore = resolveStoreExport<{
        restoreResultsForNodes: (nodeIds: string[]) => Promise<void>;
      }>(executionStoreModule, "useExecutionStore");
      executionStore
        ?.getState()
        .restoreResultsForNodes(rfNodes.map((n) => n.id));
    } catch {
      /* ignore */
    }
  },

  newWorkflow: async (name) => {
    const wf = await workflowIpc.create({ name });
    const { nodes, edges } = getDefaultNewWorkflowContent();
    set({
      workflowId: wf.id,
      workflowName: wf.name,
      nodes,
      edges,
      isDirty: false,
    });
  },

  setWorkflowName: (name) => set({ workflowName: name, isDirty: true }),

  renameWorkflow: async (newName) => {
    const { workflowId } = get();
    set({ workflowName: newName });
    if (workflowId) {
      const result = (await workflowIpc.rename(
        workflowId,
        newName,
      )) as unknown as { finalName: string } | void;
      // If the backend deduplicated the name, sync it back
      if (
        result &&
        typeof result === "object" &&
        "finalName" in result &&
        result.finalName !== newName
      ) {
        set({ workflowName: result.finalName });
      }
    }
  },

  adoptNode: (iteratorId, childId) => {
    const { nodes, edges } = get();

    const iteratorNode = nodes.find((n) => n.id === iteratorId);
    const childNode = nodes.find((n) => n.id === childId);
    if (!iteratorNode || !childNode) return;

    // Prevent nesting: reject if the child is itself an Iterator node
    if (childNode.data.nodeType === "control/iterator") return;

    // Reject if child already has a parent
    if (childNode.parentNode) return;

    pushUndo({ nodes, edges });

    // Convert child position to relative coordinates (relative to iterator)
    const relativePosition = {
      x: childNode.position.x - iteratorNode.position.x,
      y: childNode.position.y - iteratorNode.position.y,
    };

    // Update childNodeIds in iterator data
    const currentChildIds: string[] =
      iteratorNode.data.childNodeIds ?? [];
    const updatedChildIds = currentChildIds.includes(childId)
      ? currentChildIds
      : [...currentChildIds, childId];

    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id === childId) {
          return {
            ...n,
            position: relativePosition,
            parentNode: iteratorId,
            extent: "parent" as const,
            data: { ...n.data },
          };
        }
        if (n.id === iteratorId) {
          return {
            ...n,
            data: {
              ...n.data,
              childNodeIds: updatedChildIds,
            },
          };
        }
        return n;
      }),
      isDirty: true,
      canUndo: true,
      canRedo: false,
    }));

    // Recalculate bounding box after adopting the child
    get().updateBoundingBox(iteratorId);
  },

  releaseNode: (iteratorId, childId) => {
    const { nodes, edges } = get();

    const iteratorNode = nodes.find((n) => n.id === iteratorId);
    const childNode = nodes.find((n) => n.id === childId);
    if (!iteratorNode || !childNode) return;

    // Only release if the child actually belongs to this iterator
    if (childNode.parentNode !== iteratorId) return;

    pushUndo({ nodes, edges });

    // Convert child position back to absolute coordinates
    const absolutePosition = {
      x: childNode.position.x + iteratorNode.position.x,
      y: childNode.position.y + iteratorNode.position.y,
    };

    // Remove from childNodeIds in iterator data
    const currentChildIds: string[] =
      iteratorNode.data.childNodeIds ?? [];
    const updatedChildIds = currentChildIds.filter(
      (id: string) => id !== childId,
    );

    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id === childId) {
          // Remove parentNode and extent by spreading without them
          const { parentNode: _, extent: _e, ...rest } = n;
          return {
            ...rest,
            position: absolutePosition,
            data: { ...n.data },
          };
        }
        if (n.id === iteratorId) {
          return {
            ...n,
            data: {
              ...n.data,
              childNodeIds: updatedChildIds,
            },
          };
        }
        return n;
      }),
      isDirty: true,
      canUndo: true,
      canRedo: false,
    }));

    // Recalculate bounding box after releasing the child
    get().updateBoundingBox(iteratorId);
  },

  updateBoundingBox: (iteratorId) => {
    const { nodes } = get();
    const iteratorNode = nodes.find((n) => n.id === iteratorId);
    if (!iteratorNode) return;

    const children = nodes.filter((n) => n.parentNode === iteratorId);
    const currentParams = iteratorNode.data.params ?? {};
    const currentW = (currentParams.__nodeWidth as number) ?? MIN_ITERATOR_WIDTH;
    const currentH = (currentParams.__nodeHeight as number) ?? MIN_ITERATOR_HEIGHT;

    // Only expand — never shrink. If children fit inside the current size, do nothing.
    let requiredWidth = MIN_ITERATOR_WIDTH;
    let requiredHeight = MIN_ITERATOR_HEIGHT;

    if (children.length > 0) {
      let maxRight = 0;
      let maxBottom = 0;
      for (const child of children) {
        const cw = (child.data?.params?.__nodeWidth as number) ?? 300;
        // Use DOM measurement for height when available (child nodes auto-size vertically)
        let ch = (child.data?.params?.__nodeHeight as number) ?? 80;
        try {
          const el = document.querySelector(`[data-id="${child.id}"]`) as HTMLElement | null;
          if (el) ch = Math.max(ch, el.offsetHeight);
        } catch { /* ignore DOM errors */ }
        const right = child.position.x + cw + CHILD_PADDING;
        const bottom = child.position.y + ch + CHILD_PADDING;
        if (right > maxRight) maxRight = right;
        if (bottom > maxBottom) maxBottom = bottom;
      }
      requiredWidth = Math.max(MIN_ITERATOR_WIDTH, maxRight + PORT_STRIP_WIDTH);
      requiredHeight = Math.max(MIN_ITERATOR_HEIGHT, maxBottom);
    }

    // Only grow, never shrink
    const newWidth = Math.max(currentW, requiredWidth);
    const newHeight = Math.max(currentH, requiredHeight);

    if (currentW === newWidth && currentH === newHeight) {
      return; // no change needed
    }

    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id === iteratorId) {
          return {
            ...n,
            data: {
              ...n.data,
              params: {
                ...n.data.params,
                __nodeWidth: newWidth,
                __nodeHeight: newHeight,
              },
            },
          };
        }
        return n;
      }),
      isDirty: true,
    }));
  },

  exposeParam: (iteratorId, param) => {
    const { nodes, edges } = get();
    const iteratorNode = nodes.find((n) => n.id === iteratorId);
    if (!iteratorNode) return;

    pushUndo({ nodes, edges });

    const params = iteratorNode.data.params ?? {};
    const paramListKey = param.direction === "input" ? "exposedInputs" : "exposedOutputs";
    const defKey = param.direction === "input" ? "inputDefinitions" : "outputDefinitions";

    // Parse existing exposed params
    const currentList: ExposedParam[] = (() => {
      try {
        const raw = params[paramListKey];
        return typeof raw === "string" ? JSON.parse(raw) : [];
      } catch {
        return [];
      }
    })();

    // Don't add duplicates
    if (currentList.some((p: ExposedParam) => p.namespacedKey === param.namespacedKey)) return;

    const updatedList = [...currentList, param];

    // Build new port definition
    const newPort: PortDefinition = {
      key: param.namespacedKey,
      label: param.namespacedKey,
      dataType: param.dataType,
      required: false,
    };

    const currentDefs: PortDefinition[] = iteratorNode.data[defKey] ?? [];
    const updatedDefs = [...currentDefs, newPort];

    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id === iteratorId) {
          return {
            ...n,
            data: {
              ...n.data,
              params: {
                ...n.data.params,
                [paramListKey]: JSON.stringify(updatedList),
              },
              [defKey]: updatedDefs,
            },
          };
        }
        return n;
      }),
      isDirty: true,
      canUndo: true,
      canRedo: false,
    }));
  },

  unexposeParam: (iteratorId, namespacedKey, direction) => {
    const { nodes, edges } = get();
    const iteratorNode = nodes.find((n) => n.id === iteratorId);
    if (!iteratorNode) return;

    pushUndo({ nodes, edges });

    const params = iteratorNode.data.params ?? {};
    const paramListKey = direction === "input" ? "exposedInputs" : "exposedOutputs";
    const defKey = direction === "input" ? "inputDefinitions" : "outputDefinitions";

    // Parse existing exposed params and remove the matching entry
    const currentList: ExposedParam[] = (() => {
      try {
        const raw = params[paramListKey];
        return typeof raw === "string" ? JSON.parse(raw) : [];
      } catch {
        return [];
      }
    })();

    const updatedList = currentList.filter(
      (p: ExposedParam) => p.namespacedKey !== namespacedKey,
    );

    // Remove the corresponding port definition
    const currentDefs: PortDefinition[] = iteratorNode.data[defKey] ?? [];
    const updatedDefs = currentDefs.filter(
      (d: PortDefinition) => d.key !== namespacedKey,
    );

    // Remove any connected edges to/from the handle
    const handleId = direction === "input"
      ? `input-${namespacedKey}`
      : `output-${namespacedKey}`;

    const edgesToRemove = edges.filter((e) =>
      direction === "input"
        ? e.target === iteratorId && e.targetHandle === handleId
        : e.source === iteratorId && e.sourceHandle === handleId,
    );
    const edgeIdsToRemove = new Set(edgesToRemove.map((e) => e.id));

    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id === iteratorId) {
          return {
            ...n,
            data: {
              ...n.data,
              params: {
                ...n.data.params,
                [paramListKey]: JSON.stringify(updatedList),
              },
              [defKey]: updatedDefs,
            },
          };
        }
        return n;
      }),
      edges: edgeIdsToRemove.size > 0
        ? state.edges.filter((e) => !edgeIdsToRemove.has(e.id))
        : state.edges,
      isDirty: true,
      canUndo: true,
      canRedo: false,
    }));
  },

  reset: () => {
    const { nodes, edges } = getDefaultNewWorkflowContent();
    set({
      nodes,
      edges,
      workflowId: null,
      workflowName: "Untitled Workflow",
      isDirty: false,
    });
  },
}));
