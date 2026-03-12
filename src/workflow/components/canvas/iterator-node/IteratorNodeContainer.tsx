/**
 * IteratorNodeContainer — ReactFlow custom node for the Iterator container.
 *
 * Layout:  [Left input port strip] [Internal canvas area] [Right output port strip]
 *
 * Exposed params flow:
 *   External edge → Iterator left handle → (runtime maps to) child node param
 *   Child node output → (runtime maps to) Iterator right handle → External edge
 *
 * The ExposeParamPicker floats ABOVE the iterator (portal-style z-index)
 * so internal child nodes never obscure it.
 */
import React, {
  memo,
  useCallback,
  useRef,
  useState,
  useMemo,
  useEffect,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Handle, Position, useReactFlow, type NodeProps } from "reactflow";
import { useWorkflowStore } from "../../../stores/workflow.store";
import { useUIStore } from "../../../stores/ui.store";
import { useExecutionStore } from "../../../stores/execution.store";
import type { PortDefinition } from "@/workflow/types/node-defs";
import type { NodeStatus } from "@/workflow/types/execution";
import type { ExposedParam } from "@/workflow/types/workflow";
import { handleLeft, handleRight } from "../custom-node/CustomNodeHandleAnchor";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { ChevronDown, ChevronUp } from "lucide-react";

/* ── constants ─────────────────────────────────────────────────────── */

const MIN_ITERATOR_WIDTH = 600;
const MIN_ITERATOR_HEIGHT = 400;
const CHILD_PADDING = 40;
const TITLE_BAR_HEIGHT = 40;
const PORT_STRIP_WIDTH = 140;
const PORT_STRIP_EMPTY_WIDTH = 24;
const PORT_ROW_HEIGHT = 32;
const PORT_HEADER_HEIGHT = 28;

/* ── types ─────────────────────────────────────────────────────────── */

export interface IteratorNodeData {
  nodeType: string;
  label: string;
  params: Record<string, unknown>;
  childNodeIds?: string[];
  inputDefinitions?: PortDefinition[];
  outputDefinitions?: PortDefinition[];
  paramDefinitions?: unknown[];
}

/* ── Gear icon (reusable) ──────────────────────────────────────────── */

const GearIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

/* ── Expose-param picker — floats above the iterator ───────────────── */

function ExposeParamPicker({
  iteratorId,
  direction,
  onClose,
}: {
  iteratorId: string;
  direction: "input" | "output";
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const nodes = useWorkflowStore((s) => s.nodes);
  const exposeParam = useWorkflowStore((s) => s.exposeParam);
  const unexposeParam = useWorkflowStore((s) => s.unexposeParam);

  const iteratorNode = nodes.find((n) => n.id === iteratorId);
  const iteratorParams = (iteratorNode?.data?.params ?? {}) as Record<string, unknown>;
  const childNodes = nodes.filter((n) => n.parentNode === iteratorId);

  const exposedList: ExposedParam[] = useMemo(() => {
    const key = direction === "input" ? "exposedInputs" : "exposedOutputs";
    try {
      const raw = iteratorParams[key];
      return typeof raw === "string" ? JSON.parse(raw) : Array.isArray(raw) ? raw : [];
    } catch { return []; }
  }, [iteratorParams, direction]);

  const isExposed = useCallback(
    (subNodeId: string, paramKey: string) =>
      exposedList.some((p) => p.subNodeId === subNodeId && p.paramKey === paramKey),
    [exposedList],
  );

  const handleToggle = useCallback(
    (subNodeId: string, subNodeLabel: string, paramKey: string, dataType: string) => {
      const nk = `${subNodeLabel}.${paramKey}`;
      if (isExposed(subNodeId, paramKey)) {
        unexposeParam(iteratorId, nk, direction);
      } else {
        exposeParam(iteratorId, {
          subNodeId, subNodeLabel, paramKey, namespacedKey: nk, direction,
          dataType: dataType as ExposedParam["dataType"],
        });
      }
    },
    [isExposed, exposeParam, unexposeParam, iteratorId, direction],
  );


  if (childNodes.length === 0) {
    return (
      <div className="nodrag nopan bg-[hsl(var(--popover))] border border-border rounded-lg shadow-2xl p-3 min-w-[220px]"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-semibold text-foreground">
            {direction === "input" ? t("workflow.configureInputs", "Configure Inputs") : t("workflow.configureOutputs", "Configure Outputs")}
          </span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-0.5 rounded">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground">{t("workflow.noChildNodes", "Add child nodes first to expose their parameters")}</p>
      </div>
    );
  }

  return (
    <div className="nodrag nopan bg-[hsl(var(--popover))] border border-border rounded-lg shadow-2xl min-w-[260px] max-h-[320px] overflow-y-auto"
      onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/50 sticky top-0 bg-[hsl(var(--popover))]">
        <span className="text-[11px] font-semibold text-foreground">
          {direction === "input" ? t("workflow.configureInputs", "Configure Inputs") : t("workflow.configureOutputs", "Configure Outputs")}
        </span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-0.5 rounded hover:bg-muted/60">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>
      <div className="p-2 space-y-2">
        {childNodes.map((child) => {
          const childLabel = String(child.data?.label ?? child.id.slice(0, 8));
          const paramDefs = (child.data?.paramDefinitions ?? []) as Array<{ key: string; label: string; dataType?: string }>;
          const childInputDefs = (child.data?.inputDefinitions ?? []) as PortDefinition[];
          const childOutputDefs = (child.data?.outputDefinitions ?? []) as PortDefinition[];
          const modelSchema = (child.data?.modelInputSchema ?? []) as Array<{ name: string; label?: string; type?: string; mediaType?: string; required?: boolean }>;

          let items: Array<{ key: string; label: string; dataType: string }>;

          if (direction === "input") {
            // For inputs: show model input schema fields (the actual user-facing params like Image, Source Image, etc.)
            // plus any input port definitions, but skip internal paramDefinitions like modelId
            const modelItems = modelSchema.map((m) => ({
              key: m.name,
              label: m.label || m.name.split("_").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
              dataType: m.mediaType ?? m.type ?? "any",
            }));
            const inputPortItems = childInputDefs.map((d) => ({ key: d.key, label: d.label, dataType: d.dataType }));
            // If no model schema, fall back to visible paramDefinitions (for non-ai-task nodes like free-tools)
            if (modelItems.length === 0) {
              const visibleParams = paramDefs
                .filter((d) => !d.key.startsWith("__") && d.key !== "modelId")
                .map((d) => ({ key: d.key, label: d.label, dataType: d.dataType ?? "any" }));
              items = [...visibleParams, ...inputPortItems];
            } else {
              items = [...modelItems, ...inputPortItems];
            }
          } else {
            // For outputs: show each child node's output ports
            items = childOutputDefs.map((d) => ({ key: d.key, label: d.label, dataType: d.dataType }));
          }

          if (items.length === 0) return null;

          return (
            <div key={child.id}>
              <div className="text-[9px] text-muted-foreground/60 uppercase tracking-wider font-semibold px-1 mb-1">{childLabel}</div>
              {items.map((item) => (
                <button
                  key={`${child.id}-${item.key}`}
                  onClick={() => handleToggle(child.id, childLabel, item.key, item.dataType)}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-[11px] transition-colors ${
                    isExposed(child.id, item.key)
                      ? "bg-cyan-500/15 text-cyan-400"
                      : "text-foreground/70 hover:bg-muted/60"
                  }`}
                >
                  <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 border ${isExposed(child.id, item.key) ? "bg-cyan-500 border-cyan-400" : "bg-transparent border-muted-foreground/30"}`} />
                  <span className="truncate flex-1 text-left">{item.label}</span>
                  {isExposed(child.id, item.key) && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="flex-shrink-0 text-cyan-400"><polyline points="20 6 9 17 4 12" /></svg>
                  )}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Portal wrapper — positions a floating panel relative to the iterator node ── */

function PickerPortal({
  nodeRef,
  side,
  offsetTop,
  children,
}: {
  nodeRef: React.RefObject<HTMLDivElement>;
  side: "left" | "right";
  offsetTop: number;
  children: React.ReactNode;
}) {
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number }>({ top: 0 });
  const portalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => {
      const rect = nodeRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (side === "left") {
        setPos({ top: rect.top + offsetTop, left: rect.left + 8 });
      } else {
        setPos({ top: rect.top + offsetTop, right: window.innerWidth - rect.right + 8 });
      }
    };
    update();
    // Track viewport transform changes (pan/zoom)
    const viewport = nodeRef.current?.closest(".react-flow__viewport");
    let mo: MutationObserver | undefined;
    if (viewport) {
      mo = new MutationObserver(update);
      mo.observe(viewport, { attributes: true, attributeFilter: ["style"] });
    }
    window.addEventListener("resize", update);
    return () => { mo?.disconnect(); window.removeEventListener("resize", update); };
  }, [nodeRef, side, offsetTop]);

  return (
    <div
      ref={portalRef}
      className="nodrag nopan fixed"
      style={{ ...pos, zIndex: 99999 }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

/* ── Add Node button portal — floats at bottom-center of iterator ── */

function AddNodePortal({
  nodeRef,
  onClick,
  label,
  title,
}: {
  nodeRef: React.RefObject<HTMLDivElement>;
  onClick: (e: React.MouseEvent) => void;
  label: string;
  title: string;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const update = () => {
      const rect = nodeRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPos({
        top: rect.bottom - 36,
        left: rect.left + rect.width / 2,
      });
    };
    update();
    const viewport = nodeRef.current?.closest(".react-flow__viewport");
    let mo: MutationObserver | undefined;
    if (viewport) {
      mo = new MutationObserver(update);
      mo.observe(viewport, { attributes: true, attributeFilter: ["style"] });
    }
    const ro = nodeRef.current ? new ResizeObserver(update) : null;
    if (nodeRef.current && ro) ro.observe(nodeRef.current);
    window.addEventListener("resize", update);
    return () => { mo?.disconnect(); ro?.disconnect(); window.removeEventListener("resize", update); };
  }, [nodeRef]);

  if (!pos) return null;

  return (
    <div
      className="nodrag nopan fixed"
      style={{ top: pos.top, left: pos.left, transform: "translateX(-50%)", zIndex: 99998 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        onClick={onClick}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-medium
          bg-cyan-500/10 text-cyan-400 border border-cyan-500/20
          hover:bg-cyan-500/20 hover:border-cyan-500/40 transition-all cursor-pointer shadow-sm backdrop-blur-sm"
        title={title}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        {label}
      </button>
    </div>
  );
}

/* ── main component ────────────────────────────────────────────────── */

function IteratorNodeContainerComponent({
  id,
  data,
  selected,
}: NodeProps<IteratorNodeData>) {
  const { t } = useTranslation();
  const nodeRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [editingCount, setEditingCount] = useState(false);
  const [countDraft, setCountDraft] = useState("");
  const countInputRef = useRef<HTMLInputElement>(null);
  const [showInputPicker, setShowInputPicker] = useState(false);
  const [showOutputPicker, setShowOutputPicker] = useState(false);
  const { getViewport, setNodes } = useReactFlow();
  const updateNodeParams = useWorkflowStore((s) => s.updateNodeParams);
  const workflowId = useWorkflowStore((s) => s.workflowId);
  const removeNode = useWorkflowStore((s) => s.removeNode);
  const toggleNodePalette = useUIStore((s) => s.toggleNodePalette);
  const status = useExecutionStore(
    (s) => s.nodeStatuses[id] ?? "idle",
  ) as NodeStatus;
  const progress = useExecutionStore((s) => s.progressMap[id]);
  const errorMessage = useExecutionStore((s) => s.errorMessages[id]);
  const { runNode, cancelNode, retryNode, continueFrom } = useExecutionStore();
  const running = status === "running";

  const iterationCount = Number(data.params?.iterationCount ?? 1);
  const savedWidth = (data.params?.__nodeWidth as number) ?? MIN_ITERATOR_WIDTH;
  const savedHeight = (data.params?.__nodeHeight as number) ?? MIN_ITERATOR_HEIGHT;
  const collapsed = (data.params?.__nodeCollapsed as boolean | undefined) ?? false;
  const shortId = id.slice(0, 8);

  const inputDefs = data.inputDefinitions ?? [];
  const outputDefs = data.outputDefinitions ?? [];
  const childNodeIds = data.childNodeIds ?? [];
  const hasChildren = childNodeIds.length > 0;

  /* ── Collapse toggle ───────────────────────────────────────────── */
  const setCollapsed = useCallback(
    (value: boolean) => updateNodeParams(id, { ...data.params, __nodeCollapsed: value }),
    [id, data.params, updateNodeParams],
  );
  const toggleCollapsed = useCallback(
    (e: React.MouseEvent) => { e.stopPropagation(); setCollapsed(!collapsed); },
    [collapsed, setCollapsed],
  );

  /* ── Effective size — uses saved dimensions (updated by updateBoundingBox) */
  const effectiveWidth = savedWidth;
  const effectiveHeight = collapsed ? TITLE_BAR_HEIGHT : savedHeight;

  /* ── Auto-expand: observe child DOM size changes ───────────────── */
  useEffect(() => {
    if (collapsed || childNodeIds.length === 0) return;
    const updateBB = useWorkflowStore.getState().updateBoundingBox;
    const observer = new ResizeObserver(() => { updateBB(id); });
    for (const cid of childNodeIds) {
      const el = document.querySelector(`[data-id="${cid}"]`) as HTMLElement | null;
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [id, childNodeIds, collapsed]);

  /* ── Iteration count editing ───────────────────────────────────── */
  const startEditingCount = useCallback((e: React.MouseEvent) => {
    e.stopPropagation(); setCountDraft(String(iterationCount)); setEditingCount(true);
  }, [iterationCount]);

  useEffect(() => {
    if (editingCount && countInputRef.current) { countInputRef.current.focus(); countInputRef.current.select(); }
  }, [editingCount]);

  const commitCount = useCallback(() => {
    const val = Math.max(1, Math.floor(Number(countDraft) || 1));
    updateNodeParams(id, { ...data.params, iterationCount: val });
    setEditingCount(false);
  }, [countDraft, id, data.params, updateNodeParams]);

  const onCountKeyDown = useCallback(
    (e: React.KeyboardEvent) => { if (e.key === "Enter") commitCount(); if (e.key === "Escape") setEditingCount(false); },
    [commitCount],
  );

  /* ── Actions ───────────────────────────────────────────────────── */
  const onRun = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (running) cancelNode(workflowId ?? "", id); else runNode(workflowId ?? "", id);
  }, [running, workflowId, id, runNode, cancelNode]);

  const onRunFromHere = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation(); continueFrom(workflowId ?? "", id);
  }, [workflowId, id, continueFrom]);

  const onDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation(); removeNode(id);
  }, [removeNode, id]);

  const handleAddNodeInside = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    useUIStore.getState().setPendingIteratorParentId(id);
    toggleNodePalette();
  }, [toggleNodePalette, id]);

  /* ── Resize handler ────────────────────────────────────────────── */
  const onEdgeResizeStart = useCallback(
    (e: React.MouseEvent, xDir: number, yDir: number) => {
      e.stopPropagation(); e.preventDefault();
      const el = nodeRef.current; if (!el) return;
      setResizing(true);
      const startX = e.clientX, startY = e.clientY;
      const startW = el.offsetWidth, startH = el.offsetHeight;
      const zoom = getViewport().zoom;
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (xDir !== 0) el.style.width = `${Math.max(MIN_ITERATOR_WIDTH, startW + dx * xDir)}px`;
        if (yDir !== 0) el.style.height = `${Math.max(MIN_ITERATOR_HEIGHT, startH + dy * yDir)}px`;
      };
      const onUp = (ev: MouseEvent) => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        el.style.width = ""; el.style.height = "";
        setResizing(false);
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        const newW = xDir !== 0 ? Math.max(MIN_ITERATOR_WIDTH, startW + dx * xDir) : undefined;
        const newH = yDir !== 0 ? Math.max(MIN_ITERATOR_HEIGHT, startH + dy * yDir) : undefined;
        setNodes((nds) => nds.map((n) => {
          if (n.id !== id) return n;
          const pos = { ...n.position };
          if (xDir === -1) pos.x += dx / zoom;
          if (yDir === -1) pos.y += dy / zoom;
          const p = { ...n.data.params };
          if (newW !== undefined) p.__nodeWidth = newW;
          if (newH !== undefined) p.__nodeHeight = newH;
          return { ...n, position: pos, data: { ...n.data, params: p } };
        }));
        useWorkflowStore.setState({ isDirty: true });
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [id, getViewport, setNodes],
  );

  /* ── Handle positions — aligned with port rows ─────────────────── */
  const getHandleTop = (index: number) =>
    TITLE_BAR_HEIGHT + PORT_HEADER_HEIGHT + PORT_ROW_HEIGHT * index + PORT_ROW_HEIGHT / 2;

  /* ── Port strip widths ─────────────────────────────────────────── */
  const leftStripWidth = inputDefs.length > 0 ? PORT_STRIP_WIDTH : PORT_STRIP_EMPTY_WIDTH;
  const rightStripWidth = outputDefs.length > 0 ? PORT_STRIP_WIDTH : PORT_STRIP_EMPTY_WIDTH;
  const contentHeight = effectiveHeight - TITLE_BAR_HEIGHT;

  /* ── Picker toggle helpers ─────────────────────────────────────── */
  const toggleInputPicker = useCallback((e: React.MouseEvent) => {
    e.stopPropagation(); setShowInputPicker((v) => !v); setShowOutputPicker(false);
  }, []);
  const toggleOutputPicker = useCallback((e: React.MouseEvent) => {
    e.stopPropagation(); setShowOutputPicker((v) => !v); setShowInputPicker(false);
  }, []);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      className="relative"
    >
      {/* Invisible hover extension above */}
      <div className="absolute -top-10 left-0 right-0 h-10" />

      {/* ── Hover toolbar ──────────────────────────────────────── */}
      {hovered && (
        <div className="absolute -top-9 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1">
          {running ? (
            <button onClick={onRun} className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[11px] font-medium shadow-lg backdrop-blur-sm bg-red-500 text-white hover:bg-red-600 transition-all">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
              {t("workflow.stop", "Stop")}
            </button>
          ) : (
            <>
              <button onClick={onRun} className="flex items-center gap-1 px-3 py-1.5 rounded-full text-[11px] font-medium shadow-lg backdrop-blur-sm bg-blue-500 text-white hover:bg-blue-600 transition-all whitespace-nowrap">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21" /></svg>
                {t("workflow.run", "Run")}
              </button>
              <button onClick={onRunFromHere} className="flex items-center gap-1 px-3 py-1.5 rounded-full text-[11px] font-medium shadow-lg backdrop-blur-sm bg-green-600 text-white hover:bg-green-700 transition-all whitespace-nowrap">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="4,4 14,12 4,20" /><polygon points="12,4 22,12 12,20" /></svg>
                {t("workflow.runFromHere", "Run from here")}
              </button>
              <button onClick={onDelete} className="flex items-center justify-center w-8 h-8 rounded-full shadow-lg backdrop-blur-sm bg-[hsl(var(--muted))] text-muted-foreground hover:bg-red-500/20 hover:text-red-400 transition-all" title={t("workflow.delete", "Delete")}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" />
                </svg>
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Main container ─────────────────────────────────────── */}
      <div
        ref={nodeRef}
        className={`
          relative rounded-xl overflow-visible
          bg-[hsl(var(--card)/0.15)] text-[hsl(var(--card-foreground))]
          border-2 border-dashed
          ${resizing ? "" : "transition-all duration-300"}
          ${running ? "border-blue-500 animate-pulse-subtle" : ""}
          ${!running && selected ? "border-cyan-500 shadow-[0_0_20px_rgba(6,182,212,.25)] ring-1 ring-cyan-500/30" : ""}
          ${!running && !selected && status === "confirmed" ? "border-green-500/70" : ""}
          ${!running && !selected && status === "unconfirmed" ? "border-orange-500/70" : ""}
          ${!running && !selected && status === "error" ? "border-red-500/70" : ""}
          ${!running && !selected && (status === "idle" || !status) ? (hovered ? "border-cyan-500/40 shadow-lg" : "border-[hsl(var(--muted-foreground)/0.3)]") : ""}
        `}
        style={{ width: effectiveWidth, height: effectiveHeight, fontSize: 13, ...(collapsed ? { overflow: "hidden" } : {}) }}
      >

        {/* ── Title bar ──────────────────────────────────────── */}
        <div
          className={`flex items-center gap-1.5 px-3 select-none rounded-t-xl border-b border-dashed border-[hsl(var(--border)/0.5)]
            ${running ? "bg-blue-500/10" : status === "confirmed" ? "bg-green-500/8" : status === "error" ? "bg-red-500/8" : "bg-[hsl(var(--card)/0.6)]"}`}
          style={{ height: TITLE_BAR_HEIGHT }}
        >
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${running ? "bg-blue-500 animate-pulse" : status === "confirmed" ? "bg-green-500" : status === "error" ? "bg-red-500" : status === "unconfirmed" ? "bg-orange-500" : "bg-[hsl(var(--muted-foreground))] opacity-30"}`} />
          <button type="button" onClick={toggleCollapsed} className="nodrag nopan flex-shrink-0 p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors" title={collapsed ? t("workflow.expandNode", "Expand") : t("workflow.collapseNode", "Collapse")}>
            {collapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
          </button>
          <div className="rounded-md bg-cyan-500/15 p-1 flex-shrink-0">
            <svg className="w-3.5 h-3.5 text-cyan-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
              <polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
            </svg>
          </div>
          <span className="font-semibold text-[13px] truncate">{data.label || t("workflow.iterator", "Iterator")}</span>
          <span className="text-[10px] text-[hsl(var(--muted-foreground))] opacity-50 font-mono flex-shrink-0">{shortId}</span>
          <div className="flex-1" />

          {/* ── Config buttons: Input / Output — always in title bar ── */}
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <button onClick={toggleInputPicker}
                className={`nodrag nopan flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors ${
                  showInputPicker ? "bg-cyan-500/20 text-cyan-400" : "text-cyan-400/50 hover:text-cyan-400 hover:bg-cyan-500/10"
                }`}>
                <GearIcon size={10} />
                <span>{t("workflow.in", "IN")}</span>
                {inputDefs.length > 0 && <span className="px-1 py-0.5 rounded bg-cyan-500/20 text-[9px]">{inputDefs.length}</span>}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("workflow.configureInputs", "Configure exposed input parameters")}</TooltipContent>
          </Tooltip>
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <button onClick={toggleOutputPicker}
                className={`nodrag nopan flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors ${
                  showOutputPicker ? "bg-cyan-500/20 text-cyan-400" : "text-cyan-400/50 hover:text-cyan-400 hover:bg-cyan-500/10"
                }`}>
                <GearIcon size={10} />
                <span>{t("workflow.out", "OUT")}</span>
                {outputDefs.length > 0 && <span className="px-1 py-0.5 rounded bg-cyan-500/20 text-[9px]">{outputDefs.length}</span>}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("workflow.configureOutputs", "Configure exposed output parameters")}</TooltipContent>
          </Tooltip>

          {/* ── Iteration count badge ── */}
          <div className="flex-shrink-0 ml-1">
            {editingCount ? (
              <input ref={countInputRef} type="number" min={1} value={countDraft}
                onChange={(e) => setCountDraft(e.target.value)} onBlur={commitCount} onKeyDown={onCountKeyDown}
                className="nodrag nopan w-14 h-6 text-center text-[11px] font-medium rounded-full bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 outline-none focus:ring-1 focus:ring-cyan-500/50" />
            ) : (
              <button onClick={startEditingCount} className="nodrag nopan h-6 px-2.5 rounded-full text-[11px] font-medium text-cyan-400 bg-cyan-500/10 hover:bg-cyan-500/20 border border-transparent hover:border-cyan-500/30 transition-colors cursor-pointer" title={t("workflow.editIterationCount", "Click to edit iteration count")}>
                ×{iterationCount}
              </button>
            )}
          </div>
        </div>

        {/* ── Expose-param pickers — rendered via portal to sit above child nodes ── */}
        {showInputPicker && createPortal(
          <PickerPortal nodeRef={nodeRef} side="left" offsetTop={TITLE_BAR_HEIGHT + 4}>
            <ExposeParamPicker iteratorId={id} direction="input" onClose={() => setShowInputPicker(false)} />
          </PickerPortal>,
          document.body,
        )}
        {showOutputPicker && createPortal(
          <PickerPortal nodeRef={nodeRef} side="right" offsetTop={TITLE_BAR_HEIGHT + 4}>
            <ExposeParamPicker iteratorId={id} direction="output" onClose={() => setShowOutputPicker(false)} />
          </PickerPortal>,
          document.body,
        )}

        {/* ── Running progress bar ───────────────────────────── */}
        {running && !collapsed && (
          <div className="px-3 py-1.5 bg-blue-500/5">
            <div className="flex items-center gap-2 mb-1">
              <svg className="animate-spin flex-shrink-0 text-blue-400" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20" />
              </svg>
              <span className="text-[11px] text-blue-400 font-medium flex-1">{progress?.message || t("workflow.running", "Running...")}</span>
              {progress && <span className="text-[10px] text-blue-400/70">{Math.round(progress.progress)}%</span>}
            </div>
            <div className="h-1.5 rounded-full bg-blue-500/20 overflow-hidden">
              <div className="h-full bg-blue-500 transition-all duration-300 ease-out rounded-full" style={{ width: `${progress?.progress ?? 0}%` }} />
            </div>
          </div>
        )}

        {/* ── Error details + Retry ──────────────────────────── */}
        {status === "error" && errorMessage && !collapsed && (
          <div className="px-3 py-1.5 bg-red-500/5">
            <div className="flex items-start gap-1.5 p-2 rounded-lg bg-red-500/10 border border-red-500/20">
              <span className="text-red-400 text-[10px] mt-0.5 flex-shrink-0">⚠</span>
              <span className="text-[10px] text-red-400/90 leading-tight line-clamp-3 break-words flex-1" title={errorMessage}>{errorMessage}</span>
              <button onClick={(e) => { e.stopPropagation(); if (workflowId) retryNode(workflowId, id); }}
                className="text-[10px] text-red-400 font-medium hover:text-red-300 transition-colors flex items-center gap-1 flex-shrink-0 ml-1" title={t("workflow.retry", "Retry")}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
                {t("workflow.retry", "Retry")}
              </button>
            </div>
          </div>
        )}

        {/* ── Body: Left port strip | Internal area | Right port strip ── */}
        {!collapsed && (
          <div className="flex" style={{ height: contentHeight }}>

            {/* ── Left strip: exposed inputs ──────────────────── */}
            <div className="flex-shrink-0 flex flex-col border-r border-dashed border-[hsl(var(--border)/0.3)]"
              style={{ width: leftStripWidth }}>
              {inputDefs.length > 0 ? (
                <>
                  <div className="flex items-center px-2 border-b border-dashed border-[hsl(var(--border)/0.2)]"
                    style={{ height: PORT_HEADER_HEIGHT }}>
                    <span className="text-[9px] text-cyan-400/60 uppercase tracking-wider font-semibold">
                      {t("workflow.inputs", "IN")}
                    </span>
                  </div>
                  <div className="flex flex-col">
                    {inputDefs.map((port) => (
                      <div key={`il-${port.key}`}
                        className="flex items-center gap-1.5 px-2 hover:bg-cyan-500/5 transition-colors"
                        style={{ height: PORT_ROW_HEIGHT }}>
                        <span className="text-[11px] text-foreground/80 truncate flex-1" title={port.label}>{port.label}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="flex-1" />
              )}
            </div>

            {/* ── Internal canvas area ────────────────────────── */}
            <div className="flex-1 relative min-w-0">
              {/* Empty state — arrow pointing down to Add Node button */}
              {!hasChildren && (
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none pb-12">
                  <div className="flex flex-col items-center gap-3 opacity-40">
                    <span className="text-[11px] text-muted-foreground">{t("workflow.iteratorEmpty", "No child nodes yet")}</span>
                    <svg width="20" height="32" viewBox="0 0 20 32" fill="none" className="text-cyan-500/60">
                      <path d="M10 0 L10 24 M4 18 L10 26 L16 18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                </div>
              )}
            </div>

            {/* ── Right strip: exposed outputs ────────────────── */}
            <div className="flex-shrink-0 flex flex-col border-l border-dashed border-[hsl(var(--border)/0.3)]"
              style={{ width: rightStripWidth }}>
              {outputDefs.length > 0 ? (
                <>
                  <div className="flex items-center justify-end px-2 border-b border-dashed border-[hsl(var(--border)/0.2)]"
                    style={{ height: PORT_HEADER_HEIGHT }}>
                    <span className="text-[9px] text-cyan-400/60 uppercase tracking-wider font-semibold">
                      {t("workflow.outputs", "OUT")}
                    </span>
                  </div>
                  <div className="flex flex-col">
                    {outputDefs.map((port) => (
                      <div key={`or-${port.key}`}
                        className="flex items-center gap-1.5 px-2 hover:bg-cyan-500/5 transition-colors justify-end"
                        style={{ height: PORT_ROW_HEIGHT }}>
                        <span className="text-[11px] text-foreground/80 truncate flex-1 text-right" title={port.label}>{port.label}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="flex-1" />
              )}
            </div>

          </div>
        )}

        {/* Collapsed child count */}
        {collapsed && hasChildren && (
          <div className="px-3 py-1 text-[10px] text-muted-foreground/60">
            {t("workflow.childNodesCount", "{{count}} child node(s)", { count: childNodeIds.length })}
          </div>
        )}

        {/* ── Resize handles ─────────────────────────────────── */}
        {selected && !collapsed && (
          <>
            <div onMouseDown={(e) => onEdgeResizeStart(e, 1, 0)} className="nodrag absolute top-2 right-0 bottom-2 w-[5px] cursor-ew-resize z-20 hover:bg-cyan-500/20" />
            <div onMouseDown={(e) => onEdgeResizeStart(e, -1, 0)} className="nodrag absolute top-2 left-0 bottom-2 w-[5px] cursor-ew-resize z-20 hover:bg-cyan-500/20" />
            <div onMouseDown={(e) => onEdgeResizeStart(e, 0, 1)} className="nodrag absolute bottom-0 left-2 right-2 h-[5px] cursor-ns-resize z-20 hover:bg-cyan-500/20" />
            <div onMouseDown={(e) => onEdgeResizeStart(e, 0, -1)} className="nodrag absolute top-0 left-2 right-2 h-[5px] cursor-ns-resize z-20 hover:bg-cyan-500/20" />
            <div onMouseDown={(e) => onEdgeResizeStart(e, 1, 1)} className="nodrag absolute bottom-0 right-0 w-3 h-3 cursor-se-resize z-30" />
            <div onMouseDown={(e) => onEdgeResizeStart(e, -1, 1)} className="nodrag absolute bottom-0 left-0 w-3 h-3 cursor-sw-resize z-30" />
            <div onMouseDown={(e) => onEdgeResizeStart(e, 1, -1)} className="nodrag absolute top-0 right-0 w-3 h-3 cursor-ne-resize z-30" />
            <div onMouseDown={(e) => onEdgeResizeStart(e, -1, -1)} className="nodrag absolute top-0 left-0 w-3 h-3 cursor-nw-resize z-30" />
          </>
        )}
      </div>

      {/* ── Add Node button — portal to sit above ReactFlow child nodes ── */}
      {!collapsed && createPortal(
        <AddNodePortal nodeRef={nodeRef} onClick={handleAddNodeInside} label={t("workflow.addNode", "Add Node")} title={t("workflow.addNodeInside", "Add node inside Iterator")} />,
        document.body,
      )}

      {/* ── Input handles (left border — external connections) ──── */}
      {!collapsed && inputDefs.map((port, i) => (
        <Handle
          key={`input-${port.key}`}
          type="target"
          position={Position.Left}
          id={`input-${port.key}`}
          style={{ ...handleLeft(false), top: getHandleTop(i) }}
          title={port.label}
        />
      ))}

      {/* ── Output handles (right border — external connections) ── */}
      {!collapsed && outputDefs.map((port, i) => (
        <Handle
          key={`output-${port.key}`}
          type="source"
          position={Position.Right}
          id={`output-${port.key}`}
          style={{ ...handleRight(), top: getHandleTop(i) }}
          title={port.label}
        />
      ))}

      {/* ── External "+" button — right side, for downstream nodes ── */}
      {(hovered || selected) && (
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="nodrag nopan absolute top-1/2 -translate-y-1/2 -right-3 z-40 flex items-center justify-center w-6 h-6 rounded-full shadow-lg backdrop-blur-sm bg-cyan-500 text-white hover:bg-cyan-600 hover:scale-110 transition-all duration-150"
              onClick={(e) => {
                e.stopPropagation();
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                window.dispatchEvent(
                  new CustomEvent("workflow:open-add-node-menu", {
                    detail: { x: rect.right, y: rect.top + rect.height / 2, sourceNodeId: id, side: "right" },
                  }),
                );
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {t("workflow.addNode", "Add Node")}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

export default memo(IteratorNodeContainerComponent);
export { MIN_ITERATOR_WIDTH, MIN_ITERATOR_HEIGHT, CHILD_PADDING };
