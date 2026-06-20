import { Router } from 'express';
import store from '../store/memory-store.js';
import { executionEvents } from '../engine/workflow-engine.js';

const router = Router();

// GET /api/executions - List all executions
router.get('/', (req, res) => {
  const { workflowId } = req.query;
  const executions = store.listExecutions(workflowId || null);
  res.json({ executions });
});

// GET /api/executions/:id - Get a specific execution
router.get('/:id', (req, res) => {
  const execution = store.getExecution(req.params.id);
  if (!execution) {
    return res.status(404).json({ error: 'Execution not found' });
  }
  res.json({ execution });
});

// GET /api/executions/:id/stream - SSE endpoint for live execution updates
router.get('/:id/stream', (req, res) => {
  const executionId = req.params.id;
  const execution = store.getExecution(executionId);

  if (!execution) {
    return res.status(404).json({ error: 'Execution not found' });
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Send initial connection event with current execution state
  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent('connected', {
    executionId,
    status: execution.status,
    nodeResults: execution.nodeResults,
  });

  // If execution is already complete, send final state and close
  if (execution.status !== 'running') {
    sendEvent('completed', execution);
    res.end();
    return;
  }

  // Subscribe to execution events
  const onStarted = (data) => sendEvent('started', data);
  const onNodeStarted = (data) => sendEvent('node:started', data);
  const onNodeSuccess = (data) => sendEvent('node:success', data);
  const onNodeError = (data) => sendEvent('node:error', data);
  const onNodeSkipped = (data) => sendEvent('node:skipped', data);
  const onCompleted = (data) => {
    sendEvent('completed', data);
    res.end();
  };

  executionEvents.on(`${executionId}:started`, onStarted);
  executionEvents.on(`${executionId}:node:started`, onNodeStarted);
  executionEvents.on(`${executionId}:node:success`, onNodeSuccess);
  executionEvents.on(`${executionId}:node:error`, onNodeError);
  executionEvents.on(`${executionId}:node:skipped`, onNodeSkipped);
  executionEvents.on(`${executionId}:completed`, onCompleted);

  // Keep alive (send a comment every 15s to prevent timeout)
  const keepAlive = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 15000);

  // Cleanup on client disconnect
  req.on('close', () => {
    clearInterval(keepAlive);
    executionEvents.off(`${executionId}:started`, onStarted);
    executionEvents.off(`${executionId}:node:started`, onNodeStarted);
    executionEvents.off(`${executionId}:node:success`, onNodeSuccess);
    executionEvents.off(`${executionId}:node:error`, onNodeError);
    executionEvents.off(`${executionId}:node:skipped`, onNodeSkipped);
    executionEvents.off(`${executionId}:completed`, onCompleted);
  });
});

export default router;
