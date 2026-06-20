import { Worker } from 'worker_threads';
import { cpus } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * WorkerPool - Manages a pool of reusable worker threads for parallel node execution.
 *
 * Each worker thread can execute any node type. Workers are long-lived and
 * receive tasks via postMessage. Results are returned via message events.
 * Tasks are queued when all workers are busy.
 */
class WorkerPool {
  /**
   * @param {number} maxWorkers - Maximum number of worker threads (default: CPU cores)
   */
  constructor(maxWorkers = cpus().length) {
    this.maxWorkers = Math.max(1, maxWorkers);
    this.workers = [];
    this.queue = [];
    this.initialized = false;
    this._taskIdCounter = 0;
  }

  /**
   * Initialize the worker pool by creating all worker threads.
   * Each worker signals 'ready' when it has loaded its node executors.
   */
  async initialize() {
    const workerPath = join(__dirname, 'node-worker.js');

    const initPromises = [];
    for (let i = 0; i < this.maxWorkers; i++) {
      initPromises.push(this._createWorker(i, workerPath));
    }

    const results = await Promise.allSettled(initPromises);

    // Always populate workers from results (handles both success and partial failure)
    this.workers = results
      .map((r, i) => r.status === 'fulfilled' ? r.value : null)
      .filter(Boolean);

    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      console.warn(`⚠️ ${failures.length}/${this.maxWorkers} workers failed to initialize:`, failures[0].reason.message);
    }

    if (this.workers.length === 0) {
      throw new Error('Failed to initialize any worker threads');
    }

    this.initialized = true;
    console.log(`⚙️ Worker pool initialized with ${this.workers.length} worker(s)`);
    return this;
  }

  /**
   * Create a single worker thread and wait for it to be ready.
   */
  async _createWorker(workerId, workerPath) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(workerPath, {
        type: 'module',
        workerData: { workerId },
      });

      const workerObj = {
        worker,
        busy: false,
        id: workerId,
      };

      const timeout = setTimeout(() => {
        worker.terminate();
        reject(new Error(`Worker ${workerId} initialization timed out`));
      }, 15000);

      worker.on('message', (msg) => {
        if (msg.type === 'ready') {
          clearTimeout(timeout);
          resolve(workerObj);
        }
      });

      worker.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      // Handle exit before 'ready' — always reject to prevent hanging promises
      worker.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Worker ${workerId} exited with code ${code} before sending ready`));
      });
    });
  }

  /**
   * Execute a node in a worker thread.
   *
   * @param {Object} node - The node configuration (must have id, type, name, parameters)
   * @param {Object} inputData - The input data for the node
   * @returns {Promise<Object>} The execution result
   */
  executeNode(node, inputData) {
    return new Promise((resolve, reject) => {
      const taskId = this._taskIdCounter++;
      const task = { taskId, node, inputData, resolve, reject };

      const availableWorker = this.workers.find(w => !w.busy);
      if (availableWorker) {
        this._runTask(availableWorker, task);
      } else {
        this.queue.push(task);
      }
    });
  }

  /**
   * Run a single task on a specific worker.
   */
  _runTask(workerObj, task) {
    workerObj.busy = true;

    const cleanup = () => {
      workerObj.worker.removeListener('message', onMessage);
      workerObj.worker.removeListener('error', onError);
      workerObj.worker.removeListener('exit', onExit);
    };

    const onMessage = (msg) => {
      if (msg.type === 'result' && msg.taskId === task.taskId) {
        cleanup();
        workerObj.busy = false;
        task.resolve(msg);
        this._processQueue();
      }
    };

    const onError = (err) => {
      cleanup();
      workerObj.busy = false;
      task.reject(err);
      this._processQueue();
    };

    const onExit = (code) => {
      cleanup();
      workerObj.busy = false;
      task.reject(new Error(`Worker ${workerObj.id} exited unexpectedly with code ${code} during task ${task.taskId}`));
      this._processQueue();
      // Replace the dead worker
      this._replaceWorker(workerObj.id).catch(err => {
        console.error(`Failed to replace worker ${workerObj.id}:`, err.message);
      });
    };

    workerObj.worker.on('message', onMessage);
    workerObj.worker.on('error', onError);
    workerObj.worker.on('exit', onExit);

    workerObj.worker.postMessage({
      type: 'execute',
      taskId: task.taskId,
      node: task.node,
      inputData: task.inputData,
    });
  }

  /**
   * Attempt to replace a dead worker.
   */
  async _replaceWorker(workerId) {
    const workerPath = join(__dirname, 'node-worker.js');
    try {
      const newWorker = await this._createWorker(workerId, workerPath);
      // Replace in the workers array
      const idx = this.workers.findIndex(w => w.id === workerId);
      if (idx !== -1) {
        this.workers[idx] = newWorker;
        console.log(`🔁 Replaced worker ${workerId}`);
      }
    } catch (err) {
      console.warn(`⚠️ Failed to replace worker ${workerId}:`, err.message);
      // Remove from pool
      this.workers = this.workers.filter(w => w.id !== workerId);
    }
  }

  /**
   * Process the task queue when a worker becomes available.
   */
  _processQueue() {
    if (this.queue.length === 0) return;

    const availableWorker = this.workers.find(w => !w.busy);
    if (!availableWorker) return;

    const task = this.queue.shift();
    this._runTask(availableWorker, task);
  }

  /**
   * Get pool statistics.
   */
  getStats() {
    return {
      totalWorkers: this.workers.length,
      busyWorkers: this.workers.filter(w => w.busy).length,
      queuedTasks: this.queue.length,
      initialized: this.initialized,
    };
  }

  /**
   * Gracefully terminate all workers and clear the queue.
   */
  async terminate() {
    console.log('🛑 Terminating worker pool...');
    const results = this.workers.map(w => w.worker.terminate());
    this.workers = [];
    this.queue = [];
    await Promise.all(results);
    this.initialized = false;
    console.log('✅ Worker pool terminated');
  }
}

export default WorkerPool;
