/**
 * useIteratorAdoption — Hook that manages the relationship between Iterator
 * containers and their child nodes.
 *
 * Key behaviors:
 * - Child nodes are locked inside their parent Iterator (extent: "parent")
 * - External nodes cannot be dragged into an Iterator — they must be created inside
 * - Child nodes cannot be dragged out of their parent Iterator
 * - Auto-adopts newly created nodes if their position falls inside an Iterator
 * - Releases children before deletion and updates bounding boxes
 * - Clamps child node positions to stay within the Iterator bounding box
 */
import { useCallback, useRef } from "react";
import type { NodeChange } from "reactflow";
import { useWorkflowStore } from "../stores/workflow.store";

/* ── constants ─────────────────────────────────────────────────────── */

const TITLE_BAR_HEIGHT = 40;
const CLAMP_PADDING = 10;
const PORT_STRIP_MIN_WIDTH = 24; // minimum width of port strips (when no ports)

/* ── helpers ───────────────────────────────────────────────────────── */

/* ── hook ──────────────────────────────────────────────────────────── */

export function useIteratorAdoption() {
  const draggingNodesRef = useRef<Set<string>>(new Set());

  /**
   * Call this from the onNodesChange wrapper to:
   * 1. Clamp child nodes within their parent Iterator bounds during drag
   * 2. Update bounding boxes when children move
   *
   * Child nodes are locked inside — they cannot be dragged out.
   * External nodes are NOT auto-adopted on drag — only on creation.
   */
  const handleNodesChangeForAdoption = useCallback(
    (changes: NodeChange[]) => {
      const posChanges = changes.filter(
        (c): c is NodeChange & {
          type: "position";
          id: string;
          dragging?: boolean;
          position?: { x: number; y: number };
        } => c.type === "position",
      );
      if (posChanges.length === 0) return;

      const { nodes } = useWorkflowStore.getState();

      // Track dragging state
      for (const change of posChanges) {
        if (change.dragging === true) {
          draggingNodesRef.current.add(change.id);
        }
        if (change.dragging === false) {
          draggingNodesRef.current.delete(change.id);
        }
      }

      // Clamp child nodes within their parent Iterator bounds
      const nodesToClamp: Array<{ nodeId: string; clampedPos: { x: number; y: number } }> = [];

      // Collect all iterator nodes for external-node rejection
      const iteratorNodes = nodes.filter((n) => n.type === "control/iterator");

      for (const change of posChanges) {
        const node = nodes.find((n) => n.id === change.id);
        if (!node) continue;

        if (node.parentNode) {
          // This node is a child of an Iterator — enforce bounds (keep inside)
          const parentIterator = nodes.find((n) => n.id === node.parentNode);
          if (!parentIterator) continue;

          const itW = (parentIterator.data?.params?.__nodeWidth as number) ?? 600;
          const itH = (parentIterator.data?.params?.__nodeHeight as number) ?? 400;

          const pos = change.position ?? node.position;
          const childW = (node.data?.params?.__nodeWidth as number) ?? 300;
          const childH = (node.data?.params?.__nodeHeight as number) ?? 80;

          const inputDefs = parentIterator.data?.inputDefinitions ?? [];
          const outputDefs = parentIterator.data?.outputDefinitions ?? [];
          const leftStrip = (inputDefs as unknown[]).length > 0 ? 140 : PORT_STRIP_MIN_WIDTH;
          const rightStrip = (outputDefs as unknown[]).length > 0 ? 140 : PORT_STRIP_MIN_WIDTH;
          const minX = leftStrip + CLAMP_PADDING;
          const maxX = Math.max(minX, itW - childW - rightStrip - CLAMP_PADDING);
          const minY = TITLE_BAR_HEIGHT + CLAMP_PADDING;
          const maxY = Math.max(minY, itH - childH - CLAMP_PADDING);

          const clampedX = Math.min(Math.max(pos.x, minX), maxX);
          const clampedY = Math.min(Math.max(pos.y, minY), maxY);

          if (clampedX !== pos.x || clampedY !== pos.y) {
            nodesToClamp.push({
              nodeId: change.id,
              clampedPos: { x: clampedX, y: clampedY },
            });
          }
        } else if (node.type !== "control/iterator" && change.dragging) {
          // External node being dragged — reject if it overlaps any iterator
          const pos = change.position ?? node.position;
          const nodeW = (node.data?.params?.__nodeWidth as number) ?? 300;
          const nodeH = (node.data?.params?.__nodeHeight as number) ?? 80;

          for (const it of iteratorNodes) {
            const itX = it.position.x;
            const itY = it.position.y;
            const itW = (it.data?.params?.__nodeWidth as number) ?? 600;
            const itH = (it.data?.params?.__nodeHeight as number) ?? 400;

            // Check overlap (AABB intersection)
            const overlapsX = pos.x < itX + itW && pos.x + nodeW > itX;
            const overlapsY = pos.y < itY + itH && pos.y + nodeH > itY;

            if (overlapsX && overlapsY) {
              // Push the node to the nearest edge outside the iterator
              const pushLeft = itX - nodeW - CLAMP_PADDING;
              const pushRight = itX + itW + CLAMP_PADDING;
              const pushTop = itY - nodeH - CLAMP_PADDING;
              const pushBottom = itY + itH + CLAMP_PADDING;

              // Find the smallest displacement
              const dLeft = Math.abs(pos.x - pushLeft);
              const dRight = Math.abs(pos.x - pushRight);
              const dTop = Math.abs(pos.y - pushTop);
              const dBottom = Math.abs(pos.y - pushBottom);
              const minD = Math.min(dLeft, dRight, dTop, dBottom);

              let newX = pos.x;
              let newY = pos.y;
              if (minD === dLeft) newX = pushLeft;
              else if (minD === dRight) newX = pushRight;
              else if (minD === dTop) newY = pushTop;
              else newY = pushBottom;

              nodesToClamp.push({
                nodeId: change.id,
                clampedPos: { x: newX, y: newY },
              });
              break; // only need to resolve one iterator collision
            }
          }
        }
      }

      // Apply clamped positions
      if (nodesToClamp.length > 0) {
        useWorkflowStore.setState((state) => ({
          nodes: state.nodes.map((n) => {
            const clamp = nodesToClamp.find((c) => c.nodeId === n.id);
            if (clamp) {
              return { ...n, position: clamp.clampedPos };
            }
            return n;
          }),
        }));
      }
    },
    [],
  );

  /**
   * Call after a new node is created.
   *
   * External nodes (dragged from palette or pasted) are NOT auto-adopted
   * into iterators. Adoption is handled directly by the NodePalette when
   * pendingIteratorParentId is set.
   */
  const handleNodeCreated = useCallback((_newNodeId: string) => {
    // No-op: adoption is handled by NodePalette.handleClick when
    // pendingIteratorParentId is set. External drag/paste should NOT
    // auto-adopt into iterators.
  }, []);

  /**
   * Call before nodes are deleted. For each deleted node that has a parentNode
   * (i.e., is a child of an Iterator), release it and update the bounding box.
   */
  const handleNodesDeleted = useCallback((deletedNodeIds: string[]) => {
    const { nodes, releaseNode, updateBoundingBox } =
      useWorkflowStore.getState();

    const affectedIteratorIds = new Set<string>();

    for (const nodeId of deletedNodeIds) {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node || !node.parentNode) continue;

      const parentId = node.parentNode;
      releaseNode(parentId, nodeId);
      affectedIteratorIds.add(parentId);
    }

    // Update bounding boxes for all affected iterators
    for (const itId of affectedIteratorIds) {
      updateBoundingBox(itId);
    }
  }, []);

  return {
    handleNodesChangeForAdoption,
    handleNodeCreated,
    handleNodesDeleted,
  };
}
