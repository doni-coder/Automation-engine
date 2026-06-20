import { Router } from 'express';
import store from '../store/memory-store.js';
import { executeWorkflow, getStartNode, executeNode } from '../engine/workflow-engine.js';
import { webhookTriggerDefinition } from '../nodes/webhook-trigger.js';
import { whatsappDefinition } from '../nodes/whatsapp.js';
import { httpDefinition } from '../nodes/http.js';
import { routerDefinition } from '../nodes/router.js';
import { aiModelDefinition } from '../nodes/ai-model.js';

const router = Router();

// Get all registered node types
const NODE_TYPES = {
  webhookTrigger: { definition: webhookTriggerDefinition },
  whatsapp: { definition: whatsappDefinition },
  http: { definition: httpDefinition },
  router: { definition: routerDefinition },
  aiModel: { definition: aiModelDefinition },
};

// GET /api/workflows - List all workflows
router.get('/', (req, res) => {
  const workflows = store.listWorkflows();
  res.json({ workflows });
});

// GET /api/workflows/types - Get available node types
router.get('/types', (req, res) => {
  res.json({ nodeTypes: NODE_TYPES });
});

// GET /api/workflows/:id - Get a specific workflow
router.get('/:id', (req, res) => {
  const workflow = store.getWorkflow(req.params.id);
  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found' });
  }
  res.json({ workflow });
});

// POST /api/workflows - Create a new workflow
router.post('/', (req, res) => {
  const workflow = store.createWorkflow(req.body);
  res.status(201).json({ workflow });
});

// PUT /api/workflows/:id - Update a workflow
router.put('/:id', (req, res) => {
  const workflow = store.updateWorkflow(req.params.id, req.body);
  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found' });
  }
  res.json({ workflow });
});

// DELETE /api/workflows/:id - Delete a workflow
router.delete('/:id', (req, res) => {
  const deleted = store.deleteWorkflow(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: 'Workflow not found' });
  }
  res.json({ success: true });
});

// POST /api/workflows/:id/toggle - Toggle workflow active state
router.post('/:id/toggle', (req, res) => {
  const { active } = req.body;
  const workflow = store.toggleActive(req.params.id, active);
  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found' });
  }
  res.json({ workflow });
});

// POST /api/workflows/:id/test - Test run a workflow (now async with live streaming support)
router.post('/:id/test', async (req, res) => {
  try {
    const workflow = store.getWorkflow(req.params.id);
    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    const startNode = getStartNode(workflow.nodes);
    if (!startNode) {
      return res.status(400).json({ error: 'No start node found in workflow' });
    }

    const triggerData = req.body.data || {};

    // Create execution record
    const execution = store.createExecution(workflow.id, triggerData);

    // Start execution in background for live streaming (with worker pool)
    executeWorkflow(
      workflow.id,
      startNode.id,
      triggerData,
      execution.id,
      req.workerPool
    ).catch(err => {
      console.error('Background execution error:', err);
    });

    // Return immediately with the execution ID
    res.json({ execution });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/workflows/:id/execute-node - Execute a single node with provided input data
router.post('/:id/execute-node', async (req, res) => {
  try {
    const workflow = store.getWorkflow(req.params.id);
    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    const { nodeId, inputData } = req.body;
    if (!nodeId) {
      return res.status(400).json({ error: 'nodeId is required' });
    }

    const node = workflow.nodes.find(n => n.id === nodeId);
    if (!node) {
      return res.status(404).json({ error: 'Node not found in workflow' });
    }

    // Execute just this single node directly
    const result = await executeNode(node, inputData || {});
    res.json({ result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/workflows/:id/test-node - Execute the workflow up to a specific node (for node-level testing)
router.post('/:id/test-node', async (req, res) => {
  try {
    const workflow = store.getWorkflow(req.params.id);
    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    const { nodeId, triggerData: incomingTriggerData } = req.body;
    if (!nodeId) {
      return res.status(400).json({ error: 'nodeId is required' });
    }

    const targetNode = workflow.nodes.find(n => n.id === nodeId);
    if (!targetNode) {
      return res.status(404).json({ error: 'Target node not found in workflow' });
    }

    // Find the trigger node
    const startNode = getStartNode(workflow.nodes);
    if (!startNode) {
      return res.status(400).json({ error: 'No start node found in workflow' });
    }

    const triggerData = incomingTriggerData || { test: true, timestamp: new Date().toISOString(), message: 'Node test execution' };

    // Execute full workflow - we'll extract just the target node's results
    const execution = await executeWorkflow(workflow.id, startNode.id, triggerData, null, req.workerPool);

    // Find the specific node result
    const nodeResult = execution.nodeResults.find(r => r.nodeId === nodeId);
    
    res.json({
      execution,
      nodeResult: nodeResult || null,
      allNodeOutputs: execution.nodeResults.reduce((acc, r) => {
        acc[r.nodeId] = { name: r.nodeName, type: r.nodeType, outputData: r.outputData, status: r.status };
        return acc;
      }, {}),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/workflows/:id/test-sync - Run synchronously and wait for result
router.post('/:id/test-sync', async (req, res) => {
  try {
    const workflow = store.getWorkflow(req.params.id);
    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    const startNode = getStartNode(workflow.nodes);
    if (!startNode) {
      return res.status(400).json({ error: 'No start node found in workflow' });
    }

    const triggerData = req.body.data || { test: true, timestamp: new Date().toISOString(), message: 'Test execution' };
    const execution = await executeWorkflow(workflow.id, startNode.id, triggerData, null, req.workerPool);
    res.json({ execution });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
