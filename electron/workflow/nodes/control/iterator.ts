/**
 * Iterator node — container node that executes an internal sub-workflow
 * multiple times, aggregating results across iterations.
 */
import {
  BaseNodeHandler,
  type NodeExecutionContext,
  type NodeExecutionResult,
} from "../base";
import type { NodeTypeDefinition } from "../../../../src/workflow/types/node-defs";
import type { ExposedParam } from "../../../../src/workflow/types/workflow";
import type { NodeRegistry } from "../registry";
import { getChildNodes } from "../../db/node.repo";
import { getInternalEdges } from "../../db/edge.repo";
import { topologicalLevels } from "../../engine/scheduler";

export const iteratorDef: NodeTypeDefinition = {
  type: "control/iterator",
  category: "control",
  label: "Iterator",
  inputs: [],
  outputs: [],
  params: [
    {
      key: "iterationCount",
      label: "Iteration Count",
      type: "number",
      default: 1,
      validation: { min: 1 },
    },
    {
      key: "exposedInputs",
      label: "Exposed Inputs",
      type: "string",
      default: "[]",
    },
    {
      key: "exposedOutputs",
      label: "Exposed Outputs",
      type: "string",
      default: "[]",
    },
  ],
};

export class IteratorNodeHandler extends BaseNodeHandler {
  constructor(private registry: NodeRegistry) {
    super(iteratorDef);
  }

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const start = Date.now();

    // 1. Parse iteration config from params
    const iterationCount = Math.max(1, Number(ctx.params.iterationCount) || 1);
    const exposedInputs = this.parseExposedParams(ctx.params.exposedInputs);
    const exposedOutputs = this.parseExposedParams(ctx.params.exposedOutputs);

    // 2. Load child nodes and internal edges
    const childNodes = getChildNodes(ctx.nodeId);
    const internalEdges = getInternalEdges(ctx.workflowId);

    // Filter internal edges to only those between our child nodes
    const childNodeIds = childNodes.map((n) => n.id);
    const childNodeIdSet = new Set(childNodeIds);
    const relevantEdges = internalEdges.filter(
      (e) => childNodeIdSet.has(e.sourceNodeId) && childNodeIdSet.has(e.targetNodeId),
    );

    if (childNodes.length === 0) {
      return {
        status: "success",
        outputs: {},
        durationMs: Date.now() - start,
        cost: 0,
      };
    }

    // 3. Topologically sort child nodes
    const simpleEdges = relevantEdges.map((e) => ({
      sourceNodeId: e.sourceNodeId,
      targetNodeId: e.targetNodeId,
    }));
    const levels = topologicalLevels(childNodeIds, simpleEdges);

    // 4. Build lookup maps
    const childNodeMap = new Map(childNodes.map((n) => [n.id, n]));

    // Build input routing: map from subNodeId -> paramKey -> external value
    const inputRouting = new Map<string, Map<string, unknown>>();
    for (const ep of exposedInputs) {
      const externalValue = ctx.inputs[ep.namespacedKey];
      if (externalValue !== undefined) {
        if (!inputRouting.has(ep.subNodeId)) {
          inputRouting.set(ep.subNodeId, new Map());
        }
        inputRouting.get(ep.subNodeId)!.set(ep.paramKey, externalValue);
      }
    }

    // 5. Execute iterations
    const iterationResults: Array<Record<string, unknown>> = [];
    let totalCost = 0;

    for (let i = 0; i < iterationCount; i++) {
      // Track outputs per sub-node for this iteration (for internal edge resolution)
      const subNodeOutputs = new Map<string, Record<string, unknown>>();

      // Execute sub-nodes level by level
      let iterationFailed = false;
      let failedSubNodeId = "";
      let failedError = "";

      for (const level of levels) {
        if (iterationFailed) break;

        for (const subNodeId of level) {
          if (iterationFailed) break;

          const subNode = childNodeMap.get(subNodeId);
          if (!subNode) continue;

          const handler = this.registry.getHandler(subNode.nodeType);
          if (!handler) {
            return {
              status: "error",
              outputs: {},
              durationMs: Date.now() - start,
              cost: totalCost,
              error: `No handler found for sub-node type: ${subNode.nodeType} (node: ${subNodeId})`,
            };
          }

          // Build params for this sub-node: base params + external inputs + iteration index
          const subParams: Record<string, unknown> = { ...subNode.params };

          // Inject external input values
          const externalInputs = inputRouting.get(subNodeId);
          if (externalInputs) {
            for (const [paramKey, value] of externalInputs) {
              subParams[paramKey] = value;
            }
          }

          // Inject iteration index
          subParams.__iterationIndex = i;

          // Resolve internal edge inputs from upstream sub-node outputs
          const subInputs = this.resolveSubNodeInputs(
            subNodeId,
            relevantEdges,
            subNodeOutputs,
          );

          // Also inject unconnected param defaults (already in subParams from subNode.params)
          // External inputs that aren't connected fall back to the sub-node's default value
          // which is already present in subNode.params

          const subCtx: NodeExecutionContext = {
            nodeId: subNodeId,
            nodeType: subNode.nodeType,
            params: subParams,
            inputs: subInputs,
            workflowId: ctx.workflowId,
            abortSignal: ctx.abortSignal,
            onProgress: (_progress, message) => {
              // Forward sub-node progress as part of overall iteration progress
              const iterationProgress = (i / iterationCount) * 100;
              ctx.onProgress(iterationProgress, message);
            },
          };

          try {
            const result = await handler.execute(subCtx);
            totalCost += result.cost;

            if (result.status === "error") {
              iterationFailed = true;
              failedSubNodeId = subNodeId;
              failedError = result.error || "Unknown sub-node error";
              break;
            }

            // Store sub-node outputs for downstream internal edge resolution
            subNodeOutputs.set(subNodeId, result.outputs);
          } catch (error) {
            return {
              status: "error",
              outputs: {},
              durationMs: Date.now() - start,
              cost: totalCost,
              error: `Sub-node ${subNodeId} threw: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }
      }

      if (iterationFailed) {
        return {
          status: "error",
          outputs: {},
          durationMs: Date.now() - start,
          cost: totalCost,
          error: `Sub-node ${failedSubNodeId} failed: ${failedError}`,
        };
      }

      // Collect exposed output values for this iteration
      const iterOutputs: Record<string, unknown> = {};
      for (const ep of exposedOutputs) {
        const nodeOutputs = subNodeOutputs.get(ep.subNodeId);
        if (nodeOutputs) {
          // Key by handle ID format "output-{namespacedKey}" so the executor's
          // resolveInputs can find the value via edge.sourceOutputKey
          iterOutputs[`output-${ep.namespacedKey}`] = nodeOutputs[ep.paramKey];
        }
      }
      iterationResults.push(iterOutputs);

      // Report progress
      ctx.onProgress(((i + 1) / iterationCount) * 100, `Iteration ${i + 1}/${iterationCount} complete`);
    }

    // 6. Aggregate results
    const outputs: Record<string, unknown> = {};
    if (iterationCount === 1) {
      // N=1: return results directly
      Object.assign(outputs, iterationResults[0]);
    } else {
      // N>1: aggregate into arrays per exposed output
      for (const ep of exposedOutputs) {
        const handleKey = `output-${ep.namespacedKey}`;
        outputs[handleKey] = iterationResults.map(
          (r) => r[handleKey],
        );
      }
    }

    return {
      status: "success",
      outputs,
      resultMetadata: { ...outputs },
      durationMs: Date.now() - start,
      cost: totalCost,
    };
  }

  /**
   * Resolve inputs for a sub-node from upstream sub-node outputs via internal edges.
   */
  private resolveSubNodeInputs(
    subNodeId: string,
    internalEdges: { sourceNodeId: string; targetNodeId: string; sourceOutputKey: string; targetInputKey: string }[],
    subNodeOutputs: Map<string, Record<string, unknown>>,
  ): Record<string, unknown> {
    const inputs: Record<string, unknown> = {};
    const incomingEdges = internalEdges.filter((e) => e.targetNodeId === subNodeId);

    for (const edge of incomingEdges) {
      const sourceOutputs = subNodeOutputs.get(edge.sourceNodeId);
      if (!sourceOutputs) continue;

      const value = sourceOutputs[edge.sourceOutputKey];
      if (value === undefined) continue;

      // Parse target handle key the same way the main executor does
      const targetKey = edge.targetInputKey;
      if (targetKey.startsWith("param-")) {
        inputs[targetKey.slice(6)] = value;
      } else if (targetKey.startsWith("input-")) {
        inputs[targetKey.slice(6)] = value;
      } else {
        inputs[targetKey] = value;
      }
    }

    return inputs;
  }

  /**
   * Parse exposed params from JSON string stored in node params.
   */
  private parseExposedParams(value: unknown): ExposedParam[] {
    if (typeof value === "string") {
      try {
        return JSON.parse(value) as ExposedParam[];
      } catch {
        return [];
      }
    }
    if (Array.isArray(value)) {
      return value as ExposedParam[];
    }
    return [];
  }
}
