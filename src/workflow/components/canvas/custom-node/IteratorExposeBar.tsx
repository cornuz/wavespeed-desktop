/**
 * IteratorExposeBar — Compact bar shown at the bottom of child nodes
 * inside an Iterator container. Provides quick expose/unexpose toggles
 * for the node's parameters and ports.
 */
import { useMemo, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useWorkflowStore } from "../../../stores/workflow.store";
import type { ParamDefinition, PortDefinition } from "@/workflow/types/node-defs";
import type { ExposedParam } from "@/workflow/types/workflow";

interface IteratorExposeBarProps {
  nodeId: string;
  nodeLabel: string;
  parentIteratorId: string;
  paramDefs: ParamDefinition[];
  inputDefs: PortDefinition[];
  outputDefs: PortDefinition[];
}

export function IteratorExposeBar({
  nodeId,
  nodeLabel,
  parentIteratorId,
  paramDefs,
  inputDefs,
  outputDefs,
}: IteratorExposeBarProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const nodes = useWorkflowStore((s) => s.nodes);
  const exposeParam = useWorkflowStore((s) => s.exposeParam);
  const unexposeParam = useWorkflowStore((s) => s.unexposeParam);

  const parentIterator = nodes.find((n) => n.id === parentIteratorId);
  const iteratorParams = (parentIterator?.data?.params ?? {}) as Record<string, unknown>;

  const exposedInputs: ExposedParam[] = useMemo(() => {
    try {
      const raw = iteratorParams.exposedInputs;
      return typeof raw === "string" ? JSON.parse(raw) : Array.isArray(raw) ? raw : [];
    } catch { return []; }
  }, [iteratorParams.exposedInputs]);

  const exposedOutputs: ExposedParam[] = useMemo(() => {
    try {
      const raw = iteratorParams.exposedOutputs;
      return typeof raw === "string" ? JSON.parse(raw) : Array.isArray(raw) ? raw : [];
    } catch { return []; }
  }, [iteratorParams.exposedOutputs]);

  const subNodeLabel = nodeLabel;
  const getNamespacedKey = (paramKey: string) => `${subNodeLabel}.${paramKey}`;

  const isExposed = useCallback(
    (paramKey: string, direction: "input" | "output") => {
      const nk = getNamespacedKey(paramKey);
      const list = direction === "input" ? exposedInputs : exposedOutputs;
      return list.some((p) => p.namespacedKey === nk && p.subNodeId === nodeId);
    },
    [exposedInputs, exposedOutputs, nodeId, subNodeLabel],
  );

  const handleToggle = useCallback(
    (paramKey: string, direction: "input" | "output", dataType: string) => {
      const nk = getNamespacedKey(paramKey);
      if (isExposed(paramKey, direction)) {
        unexposeParam(parentIteratorId, nk, direction);
      } else {
        const param: ExposedParam = {
          subNodeId: nodeId,
          subNodeLabel,
          paramKey,
          namespacedKey: nk,
          direction,
          dataType: dataType as ExposedParam["dataType"],
        };
        exposeParam(parentIteratorId, param);
      }
    },
    [isExposed, exposeParam, unexposeParam, parentIteratorId, nodeId, subNodeLabel],
  );

  // Filter to user-visible params only
  const visibleParamDefs = paramDefs.filter((d) => !d.key.startsWith("__"));

  // Count total exposed
  const exposedCount = useMemo(() => {
    let count = 0;
    for (const d of visibleParamDefs) {
      if (isExposed(d.key, "input")) count++;
    }
    for (const d of inputDefs) {
      if (isExposed(d.key, "input")) count++;
    }
    for (const d of outputDefs) {
      if (isExposed(d.key, "output")) count++;
    }
    return count;
  }, [visibleParamDefs, inputDefs, outputDefs, isExposed]);

  const hasExposableItems = visibleParamDefs.length > 0 || inputDefs.length > 0 || outputDefs.length > 0;
  if (!hasExposableItems) return null;

  return (
    <div className="nodrag nopan border-t border-dashed border-cyan-500/20 bg-cyan-500/5">
      {/* Toggle bar */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] text-cyan-400 hover:bg-cyan-500/10 transition-colors"
      >
        <svg className="w-3 h-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="17 1 21 5 17 9" />
          <path d="M3 11V9a4 4 0 0 1 4-4h14" />
          <polyline points="7 23 3 19 7 15" />
          <path d="M21 13v2a4 4 0 0 1-4 4H3" />
        </svg>
        <span className="font-medium">
          {t("workflow.exposeToIterator", "Expose to Iterator")}
        </span>
        {exposedCount > 0 && (
          <span className="px-1.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-400 text-[9px] font-semibold">
            {exposedCount}
          </span>
        )}
        <svg
          className={`w-3 h-3 ml-auto transition-transform ${expanded ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Expanded expose controls */}
      {expanded && (
        <div className="px-3 pb-2 space-y-1.5">
          {/* Parameters as inputs */}
          {visibleParamDefs.length > 0 && (
            <div>
              <div className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1">
                {t("workflow.params", "Parameters")}
              </div>
              {visibleParamDefs.map((def) => (
                <ExposeToggleRow
                  key={`param-${def.key}`}
                  label={def.label}
                  exposed={isExposed(def.key, "input")}
                  direction="input"
                  onToggle={() => handleToggle(def.key, "input", def.dataType ?? "any")}
                />
              ))}
            </div>
          )}

          {/* Input ports as inputs */}
          {inputDefs.length > 0 && (
            <div>
              <div className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1">
                {t("workflow.inputPorts", "Input Ports")}
              </div>
              {inputDefs.map((port) => (
                <ExposeToggleRow
                  key={`input-${port.key}`}
                  label={port.label}
                  exposed={isExposed(port.key, "input")}
                  direction="input"
                  onToggle={() => handleToggle(port.key, "input", port.dataType)}
                />
              ))}
            </div>
          )}

          {/* Output ports as outputs */}
          {outputDefs.length > 0 && (
            <div>
              <div className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1">
                {t("workflow.outputPorts", "Output Ports")}
              </div>
              {outputDefs.map((port) => (
                <ExposeToggleRow
                  key={`output-${port.key}`}
                  label={port.label}
                  exposed={isExposed(port.key, "output")}
                  direction="output"
                  onToggle={() => handleToggle(port.key, "output", port.dataType)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Single toggle row ─────────────────────────────────────────────── */

function ExposeToggleRow({
  label,
  exposed,
  direction,
  onToggle,
}: {
  label: string;
  exposed: boolean;
  direction: "input" | "output";
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const dirIcon = direction === "input" ? "←" : "→";

  return (
    <div className="flex items-center justify-between gap-2 py-0.5">
      <span className="text-[10px] text-foreground/70 truncate flex-1">
        {dirIcon} {label}
      </span>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        className={`flex-shrink-0 px-2 py-0.5 rounded text-[9px] font-medium transition-colors ${
          exposed
            ? "bg-cyan-500/20 text-cyan-400 hover:bg-red-500/15 hover:text-red-400"
            : "bg-muted/50 text-muted-foreground hover:bg-cyan-500/15 hover:text-cyan-400"
        }`}
      >
        {exposed
          ? t("workflow.exposed", "Exposed")
          : t("workflow.expose", "Expose")}
      </button>
    </div>
  );
}
