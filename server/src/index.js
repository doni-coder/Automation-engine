import express from 'express';
import cors from 'cors';
import workflowsRouter from './routes/workflows.js';
import executionsRouter from './routes/executions.js';
import webhookRouter from './routes/webhook.js';
import WorkerPool from './engine/worker-pool.js';
import { executeWorkflow } from './engine/workflow-engine.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Worker pool for multi-threaded node execution
let workerPool = null;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Make worker pool available to routes
app.use((req, res, next) => {
  req.workerPool = workerPool;
  next();
});

// API Routes
app.use('/api/workflows', workflowsRouter);
app.use('/api/executions', executionsRouter);
app.use('/webhook', webhookRouter);

// Health check
app.get('/api/health', (req, res) => {
  const poolStats = workerPool ? workerPool.getStats() : { initialized: false };
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    workerPool: poolStats,
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  try {
    // Initialize the worker pool
    workerPool = new WorkerPool();
    await workerPool.initialize();

    app.listen(PORT, () => {
      console.log(`🚀 n8n-clone server running on http://localhost:${PORT}`);
      console.log(`📡 Webhook endpoint: http://localhost:${PORT}/webhook/:webhookId`);
      console.log(`📋 API: http://localhost:${PORT}/api`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  if (workerPool) {
    await workerPool.terminate();
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
