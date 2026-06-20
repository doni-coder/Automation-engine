/**
 * Node Worker Thread
 *
 * This script runs inside each worker thread. It imports all node executor
 * functions and listens for execution commands from the parent thread.
 *
 * Communication protocol:
 *   parent -> worker: { type: 'execute', taskId, node, inputData }
 *   worker -> parent: { type: 'ready' }
 *   worker -> parent: { type: 'result', taskId, nodeId, status, outputData, webhookResponse, error }
 */
import { parentPort, workerData } from 'worker_threads';
import { executeWebhookTrigger } from '../nodes/webhook-trigger.js';
import { executeWhatsApp } from '../nodes/whatsapp.js';
import { executeHttp } from '../nodes/http.js';
import { executeRouter } from '../nodes/router.js';
import { executeAiModel } from '../nodes/ai-model.js';

// All registered node executors
const nodeExecutors = {
  webhookTrigger: executeWebhookTrigger,
  whatsapp: executeWhatsApp,
  http: executeHttp,
  router: executeRouter,
  aiModel: executeAiModel,
};

// Signal that the worker is ready to receive tasks
parentPort.postMessage({ type: 'ready' });

// Listen for execution commands from the parent thread
parentPort.on('message', async (message) => {
  if (message.type === 'execute') {
    const { taskId, node, inputData } = message;

    const executor = nodeExecutors[node.type];
    const now = new Date().toISOString();

    if (!executor) {
      parentPort.postMessage({
        type: 'result',
        taskId,
        nodeId: node.id,
        status: 'skipped',
        outputData: null,
        webhookResponse: null,
        error: `Unknown node type: ${node.type}`,
        startedAt: now,
        finishedAt: now,
      });
      return;
    }

    try {
      const result = await executor(node, inputData);
      parentPort.postMessage({
        type: 'result',
        taskId,
        nodeId: node.id,
        status: result.success !== false ? 'success' : 'error',
        outputData: result.data,
        webhookResponse: result.webhookResponse || null,
        error: result.error || null,
        startedAt: now,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      parentPort.postMessage({
        type: 'result',
        taskId,
        nodeId: node.id,
        status: 'error',
        outputData: null,
        webhookResponse: null,
        error: `Node execution error: ${error.message}`,
        startedAt: now,
        finishedAt: new Date().toISOString(),
      });
    }
  }
});
