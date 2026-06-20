import { Router } from 'express';
import store from '../store/memory-store.js';
import { executeWorkflow, getStartNode } from '../engine/workflow-engine.js';

const router = Router();

router.all('/:webhookId', async (req, res) => {
  const { webhookId } = req.params;

  const workflow = store.getWorkflowByWebhookId(webhookId);
  if (!workflow) {
    return res.status(404).json({ error: 'Webhook not found or workflow is not active' });
  }

  const triggerNode = workflow.nodes.find(n => n.type === 'webhookTrigger');
  if (!triggerNode) {
    return res.status(500).json({ error: 'Workflow has no webhook trigger node' });
  }

  const triggerData = {
    method: req.method,
    headers: req.headers,
    query: req.query,
    params: req.params,
    body: req.body,
    rawBody: typeof req.body === 'object' ? JSON.stringify(req.body) : String(req.body || ''),
    url: req.originalUrl,
  };

  try {
    const execution = await executeWorkflow(workflow.id, triggerNode.id, triggerData, null, req.workerPool);
    const triggerResult = execution.nodeResults.find(r => r.nodeId === triggerNode.id);
    const webhookResponse = triggerResult?.webhookResponse;

    if (webhookResponse) {
      if (webhookResponse.headers) {
        for (const [key, value] of Object.entries(webhookResponse.headers)) {
          res.set(key, value);
        }
      }
      return res.status(webhookResponse.statusCode || 200).json(
        typeof webhookResponse.body === 'string' ? JSON.parse(webhookResponse.body) : webhookResponse.body
      );
    }

    res.json({ executionId: execution.id, status: execution.status, nodeCount: execution.nodeResults.length });
  } catch (error) {
    res.status(500).json({ error: `Workflow execution failed: ${error.message}` });
  }
});

export default router;
