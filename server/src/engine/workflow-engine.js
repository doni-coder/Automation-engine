/**
 * Workflow Engine — DAG-based Parallel Execution
 *
 * Architecture:
 *   Master thread orchestrates execution using a worker pool for parallel node execution.
 *   Each node in the workflow DAG is executed when all its dependencies are satisfied.
 *   Independent branches execute in parallel across worker threads.
 *
 * Key concepts:
 *   - Active edges: All edges from non-router nodes are always active.
 *     Router nodes deactivate all outgoing edges, then reactivate only
 *     those matching the routing conditions.
 *   - Node readiness: A node is ready when all its active incoming edges
 *     come from completed nodes.
 *   - Parallel batches: All ready nodes execute in parallel via the worker pool.
 */
import { EventEmitter } from 'events';
import { executeWebhookTrigger } from '../nodes/webhook-trigger.js';
import { executeWhatsApp } from '../nodes/whatsapp.js';
import { executeHttp } from '../nodes/http.js';
import { executeRouter } from '../nodes/router.js';
import { executeAiModel } from '../nodes/ai-model.js';
import store from '../store/memory-store.js';

// Direct executors (fallback when no worker pool is available)
const nodeExecutors = {
  webhookTrigger: executeWebhookTrigger,
  whatsapp: executeWhatsApp,
  http: executeHttp,
  router: executeRouter,
  aiModel: executeAiModel,
};

// Global event emitter for execution streaming
// Events: execution:{executionId}:{eventType}
export const executionEvents = new EventEmitter();
executionEvents.setMaxListeners(200);

/**
 * Execute a workflow using DAG-based parallel scheduling.
 *
 * @param {string} workflowId - The workflow to execute
 * @param {string} startNodeId - The node to start from
 * @param {Object} triggerData - The input data for the trigger node
 * @param {string|null} executionId - Optional pre-created execution ID for live streaming
 * @param {Object|null} workerPool - Optional WorkerPool instance for parallel execution
 * @returns {Promise<Object>} The execution result
 */
export async function executeWorkflow(
  workflowId,
  startNodeId,
  triggerData = {},
  executionId = null,
  workerPool = null
) {
  const workflow = store.getWorkflow(workflowId);
  if (!workflow) {
    throw new Error(`Workflow ${workflowId} not found`);
  }

  // Create or reuse execution record
  const existingExec = executionId && store.getExecution(executionId);
  const execution = existingExec
    ? { ...existingExec, id: executionId, workflowId, status: 'running', triggerData, nodeResults: [] }
    : store.createExecution(workflowId, triggerData);

  // Emit execution:started event
  executionEvents.emit(`${execution.id}:started`, {
    executionId: execution.id,
    workflowId,
    startedAt: execution.startedAt,
  });

  try {
    // ---- Build data structures ----
    const nodeMap = {};
    for (const node of workflow.nodes) {
      nodeMap[node.id] = node;
    }

    // outEdges: sourceNodeId -> edges[]
    // inEdges: targetNodeId -> edges[]
    const outEdges = {};
    const inEdges = {};

    for (const edge of workflow.edges) {
      if (!outEdges[edge.source]) outEdges[edge.source] = [];
      outEdges[edge.source].push({
        targetNodeId: edge.target,
        sourceHandle: edge.sourceHandle || 'main',
        targetHandle: edge.targetHandle || 'main',
      });

      if (!inEdges[edge.target]) inEdges[edge.target] = [];
      inEdges[edge.target].push({
        sourceNodeId: edge.source,
        sourceHandle: edge.sourceHandle || 'main',
        targetHandle: edge.targetHandle || 'main',
      });
    }

    // ---- Execution state ----
    const allNodeResults = [];
    const allNodeOutputs = {}; // nodeId -> outputData — ALL completed node outputs for $node context
    const completedNodes = new Set();
    const queuedNodes = new Set(); // Nodes that have been queued (to avoid duplicates)
    const nodeInputs = {}; // nodeId -> { sourceNodeId: outputData }

    // Active edges: initially, all edges are active.
    // Router nodes will deactivate all their outgoing edges and
    // selectively reactivate based on routing conditions.
    const activeEdgeSet = new Set();
    for (const edge of workflow.edges) {
      const edgeKey = edgeKeyStr(edge);
      activeEdgeSet.add(edgeKey);
    }

    // ---- Helper functions ----

    /**
     * Check if a node is ready for execution.
     * A node is ready when:
     *   1. It hasn't been executed yet
     *   2. All its active incoming edges come from completed nodes
     *   3. It has at least one active incoming edge (or is a trigger node)
     *
     * Condition 3 prevents nodes on deactivated router branches from executing.
     */
    function isNodeReady(nodeId) {
      if (completedNodes.has(nodeId)) return false;

      const incoming = inEdges[nodeId];
      if (!incoming || incoming.length === 0) {
        // Trigger node (no inputs) — always ready if not completed
        return true;
      }

      let hasActiveIncoming = false;

      // Check each active incoming edge
      for (const inEdge of incoming) {
        const key = `${inEdge.sourceNodeId}:${nodeId}:${inEdge.sourceHandle}`;
        if (!activeEdgeSet.has(key)) continue; // Inactive edge doesn't block

        hasActiveIncoming = true;

        if (!completedNodes.has(inEdge.sourceNodeId)) {
          return false; // Active predecessor not yet completed
        }
      }

      // If the node has incoming edges but none are active, it's on a
      // deactivated router branch and should not execute.
      return hasActiveIncoming;
    }

    /**
     * Build the input data object for a node.
     * Merges output data from all completed active predecessors and enriches
     * with $node context (all completed node outputs by node ID) and $prev
     * (direct predecessor output merged).
     *
     * This enables references like:
     *   - {{ $node.webhookTrigger_123.body.field }} — access any previous node output
     *   - {{ $prev.body.field }} — access direct predecessor output
     *   - {{ body.field }} — backward-compatible direct access to merged predecessor output
     */
    function buildNodeInput(nodeId) {
      const inputs = nodeInputs[nodeId] || {};
      const incoming = inEdges[nodeId] || [];

      // Collect outputs from active completed predecessors
      const collected = {};
      let hasData = false;

      for (const inEdge of incoming) {
        const key = `${inEdge.sourceNodeId}:${nodeId}:${inEdge.sourceHandle}`;
        if (!activeEdgeSet.has(key)) continue;
        if (!completedNodes.has(inEdge.sourceNodeId)) continue;

        const sourceOutput = inputs[inEdge.sourceNodeId];
        if (sourceOutput !== undefined) {
          collected[inEdge.sourceNodeId] = sourceOutput;
          hasData = true;
        }
      }

      // Build base result: merged predecessor outputs
      let baseResult = {};
      if (hasData) {
        const sourceIds = Object.keys(collected);
        if (sourceIds.length === 1) {
          baseResult = collected[sourceIds[0]];
        } else {
          baseResult = Object.assign({}, ...sourceIds.map(id => collected[id]));
        }
      }

      // Build $node context — ALL completed node outputs keyed by node ID
      // This allows accessing ANY previous node's output during runtime
      const $nodeContext = { ...allNodeOutputs };

      // Return enriched context:
      // - base result merged for backward compatibility
      // - $node: all completed node outputs by node ID
      // - $prev: direct predecessor merged output (same as baseResult)
      return {
        ...baseResult,
        $node: $nodeContext,
        $prev: { ...baseResult },
      };
    }

    /**
     * Record a node result and update execution state.
     */
    function recordNodeResult(node, result) {
      const nodeResult = {
        nodeId: node.id,
        nodeName: node.name || node.type,
        nodeType: node.type,
        status: result.status,
        inputData: buildNodeInput(node.id),
        outputData: result.outputData,
        webhookResponse: result.webhookResponse || null,
        error: result.error || null,
        startedAt: result.startedAt || new Date().toISOString(),
        finishedAt: result.finishedAt || new Date().toISOString(),
      };

      allNodeResults.push(nodeResult);
      execution.nodeResults.push(nodeResult);
      completedNodes.add(node.id);

      // Store output in allNodeOutputs for $node context
      allNodeOutputs[node.id] = result.outputData || {};

      // Store output for downstream nodes
      const downstream = outEdges[node.id] || [];
      for (const edge of downstream) {
        const key = `${node.id}:${edge.targetNodeId}:${edge.sourceHandle}`;
        if (activeEdgeSet.has(key)) {
          if (!nodeInputs[edge.targetNodeId]) {
            nodeInputs[edge.targetNodeId] = {};
          }
          nodeInputs[edge.targetNodeId][node.id] = result.outputData || {};
        }
      }

      // Update store with current results
      store.updateExecution(execution.id, {
        nodeResults: [...execution.nodeResults],
      });

      // Emit node completion event
      const eventType = result.status === 'success' ? 'node:success' : 'node:error';
      executionEvents.emit(`${execution.id}:${eventType}`, nodeResult);

      return nodeResult;
    }

    /**
     * Process router routing: always deactivate ALL outgoing edges from the router,
     * then selectively reactivate only those matching the router's matched outputs.
     *
     * This ensures:
     *   - Router that matched nothing (no fallback) → all branches deactivated
     *   - Router that failed (error status) → all branches deactivated
     *   - Router with matches → only matched branches reactivated
     */
    function processRouterRouting(node, result) {
      if (node.type !== 'router') return;

      const routerEdges = outEdges[node.id] || [];

      // Always deactivate ALL outgoing edges first
      for (const edge of routerEdges) {
        const key = `${node.id}:${edge.targetNodeId}:${edge.sourceHandle}`;
        activeEdgeSet.delete(key);
      }

      // If router didn't succeed, no edges should be reactivated
      if (result.status !== 'success') return;

      const outputData = result.outputData;
      const matchedOutputs = outputData?.matchedOutputs || [];

      // No matched outputs — nothing to reactivate (branches stay deactivated)
      if (!Array.isArray(matchedOutputs) || matchedOutputs.length === 0) {
        return;
      }

      // Reactivate only edges from matched output handles
      const matchedHandles = new Set(
        matchedOutputs.map(idx => (idx === 'fallback' ? 'fallback' : `output_${idx}`))
      );

      for (const edge of routerEdges) {
        if (matchedHandles.has(edge.sourceHandle)) {
          const key = `${node.id}:${edge.targetNodeId}:${edge.sourceHandle}`;
          activeEdgeSet.add(key);
        }
      }
    }

    /**
     * Execute a single node (via worker pool or fallback direct execution).
     */
    async function executeSingleNode(node, inputData) {
      const startedAt = new Date().toISOString();

      // Emit node:started event
      executionEvents.emit(`${execution.id}:node:started`, {
        nodeId: node.id,
        nodeName: node.name || node.type,
        nodeType: node.type,
        startedAt,
      });

      if (workerPool) {
        return await workerPool.executeNode(node, inputData);
      }

      // Fallback: direct execution (no worker pool)
      const executor = nodeExecutors[node.type];
      if (!executor) {
        return {
          type: 'result',
          nodeId: node.id,
          status: 'skipped',
          outputData: null,
          webhookResponse: null,
          error: `Unknown node type: ${node.type}`,
          startedAt,
          finishedAt: new Date().toISOString(),
        };
      }

      try {
        const r = await executor(node, inputData);
        return {
          type: 'result',
          nodeId: node.id,
          status: r.success !== false ? 'success' : 'error',
          outputData: r.data,
          webhookResponse: r.webhookResponse || null,
          error: r.error || null,
          startedAt,
          finishedAt: new Date().toISOString(),
        };
      } catch (error) {
        return {
          type: 'result',
          nodeId: node.id,
          status: 'error',
          outputData: null,
          webhookResponse: null,
          error: `Node execution error: ${error.message}`,
          startedAt,
          finishedAt: new Date().toISOString(),
        };
      }
    }

    // ---- Main execution loop ----

    // Validate start node
    const startNode = nodeMap[startNodeId];
    if (!startNode) {
      throw new Error(`Start node ${startNodeId} not found in workflow`);
    }

    // Execute the start node first
    let startResult = await executeSingleNode(startNode, triggerData);
    recordNodeResult(startNode, startResult);
    processRouterRouting(startNode, startResult);

    // Queue downstream nodes of the start node
    const startDownstream = outEdges[startNode.id] || [];
    for (const edge of startDownstream) {
      const key = `${startNode.id}:${edge.targetNodeId}:${edge.sourceHandle}`;
      if (activeEdgeSet.has(key) && !queuedNodes.has(edge.targetNodeId)) {
        queuedNodes.add(edge.targetNodeId);
      }
    }

    // Process the workflow DAG in parallel rounds
    while (queuedNodes.size > 0) {

      // Find all ready nodes from the queue
      const readyNodeIds = [];
      for (const nodeId of queuedNodes) {
        if (isNodeReady(nodeId)) {
          readyNodeIds.push(nodeId);
        }
      }

      if (readyNodeIds.length === 0) {
        // Nodes are queued but none are ready — likely a cycle or deadlock
        // Skip remaining queued nodes
        console.warn(`⚠️ Workflow ${workflowId}: ${queuedNodes.size} queued node(s) are blocked. Breaking.`);
        break;
      }

      // Remove ready nodes from the queue
      for (const nodeId of readyNodeIds) {
        queuedNodes.delete(nodeId);
      }

      // Build tasks for all ready nodes
      const readyNodes = readyNodeIds.map(id => nodeMap[id]).filter(Boolean);

      // Execute all ready nodes in parallel
      const results = await Promise.all(
        readyNodes.map(node => executeSingleNode(node, buildNodeInput(node.id)))
      );

      // Process each result
      for (let i = 0; i < results.length; i++) {
        const node = readyNodes[i];
        const result = results[i];

        recordNodeResult(node, result);
        processRouterRouting(node, result);

        // Queue downstream nodes
        const downstream = outEdges[node.id] || [];
        for (const edge of downstream) {
          const edgeKey = `${node.id}:${edge.targetNodeId}:${edge.sourceHandle}`;
          if (activeEdgeSet.has(edgeKey) && !completedNodes.has(edge.targetNodeId)) {
            queuedNodes.add(edge.targetNodeId);
          }
        }
      }
    }

    // ---- Finalize execution ----
    const hasErrors = allNodeResults.some(r => r.status === 'error');
    const finalStatus = hasErrors ? 'error' : 'success';

    store.updateExecution(execution.id, {
      status: finalStatus,
      finishedAt: new Date().toISOString(),
      nodeResults: [...execution.nodeResults],
    });

    const finalExecution = store.getExecution(execution.id);
    executionEvents.emit(`${execution.id}:completed`, finalExecution);

    return finalExecution;
  } catch (error) {
    store.updateExecution(execution.id, {
      status: 'error',
      error: error.message,
      finishedAt: new Date().toISOString(),
    });

    const failedExecution = store.getExecution(execution.id);
    executionEvents.emit(`${execution.id}:completed`, failedExecution);

    return failedExecution;
  }
}

/**
 * Get the starting node for a workflow execution.
 * If a specific node ID is provided, use that.
 * Otherwise, find the trigger node (webhookTrigger).
 *
 * @param {Array} nodes - The workflow nodes
 * @param {string} startNodeId - Optional specific start node
 * @returns {Object|null} The starting node
 */
export function getStartNode(nodes, startNodeId = null) {
  if (startNodeId) {
    return nodes.find(n => n.id === startNodeId) || null;
  }

  // Find the webhook trigger node (no inputs = trigger)
  return nodes.find(n => n.type === 'webhookTrigger') || nodes[0] || null;
}

/**
 * Execute a single node directly with the given input data.
 * Used for individual node testing.
 *
 * @param {Object} node - The node configuration
 * @param {Object} inputData - Input data for the node
 * @returns {Promise<Object>} The node execution result
 */
export async function executeNode(node, inputData) {
  const executor = nodeExecutors[node.type];
  if (!executor) {
    return {
      nodeId: node.id,
      status: 'skipped',
      outputData: null,
      webhookResponse: null,
      error: `Unknown node type: ${node.type}`,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }

  try {
    const r = await executor(node, inputData);
    return {
      nodeId: node.id,
      nodeName: node.name || node.type,
      nodeType: node.type,
      status: r.success !== false ? 'success' : 'error',
      outputData: r.data,
      webhookResponse: r.webhookResponse || null,
      error: r.error || null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      nodeId: node.id,
      nodeName: node.name || node.type,
      nodeType: node.type,
      status: 'error',
      outputData: null,
      webhookResponse: null,
      error: `Node execution error: ${error.message}`,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }
}

/**
 * Create a canonical edge key string for the active edge set.
 */
function edgeKeyStr(edge) {
  return `${edge.source}:${edge.target}:${edge.sourceHandle || 'main'}`;
}
