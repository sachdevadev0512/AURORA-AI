const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const DEFAULT_WORKERS = Math.max(
  0,
  Number(process.env.INVENTORY_SYNC_CPU_WORKERS ?? Math.min(2, Math.max(0, os.cpus().length - 1))),
);

const TASK_TIMEOUT_MS = Math.max(
  0,
  Number(process.env.INVENTORY_SYNC_CPU_TASK_TIMEOUT_MS || 120_000),
);

class CpuWorkerPool {
  constructor(workerPath, size = DEFAULT_WORKERS) {
    this.workerPath = workerPath;
    this.size = Math.max(0, size);
    this.workers = [];
    this.nextWorker = 0;
    this.pending = new Map();
    this.nextTaskId = 1;
    this.enabled = this.size > 0;

    if (this.enabled) {
      for (let i = 0; i < this.size; i += 1) {
        this.spawnWorker();
      }
    }
  }

  rejectAllPending(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  removeWorker(deadWorker) {
    this.workers = this.workers.filter((worker) => worker !== deadWorker);
    if (this.enabled && this.workers.length < this.size) {
      this.spawnWorker();
    }
  }

  spawnWorker() {
    const worker = new Worker(this.workerPath);

    worker.on('message', (message) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    });

    worker.on('error', (error) => {
      console.warn('[CpuWorkerPool] Worker error:', error.message);
      this.rejectAllPending(error);
      this.removeWorker(worker);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        console.warn(`[CpuWorkerPool] Worker exited with code ${code}`);
      }
      this.removeWorker(worker);
    });

    this.workers.push(worker);
  }

  async run(task, payload) {
    if (!this.enabled || this.workers.length === 0) {
      return null;
    }

    const id = this.nextTaskId;
    this.nextTaskId += 1;

    const worker = this.workers[this.nextWorker % this.workers.length];
    this.nextWorker += 1;

    return new Promise((resolve, reject) => {
      let timer = null;
      if (TASK_TIMEOUT_MS > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`CPU worker task timed out after ${TASK_TIMEOUT_MS}ms`));
        }, TASK_TIMEOUT_MS);
      }

      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, task, payload });
    });
  }

  async shutdown() {
    await Promise.all(this.workers.map((worker) => worker.terminate()));
    this.workers = [];
    this.enabled = false;
    this.rejectAllPending(new Error('CPU worker pool shutting down'));
  }
}

let inventorySyncPool = null;

function getInventorySyncCpuPool() {
  if (!inventorySyncPool) {
    inventorySyncPool = new CpuWorkerPool(
      path.join(__dirname, '../workers/inventorySyncCpuWorker.js'),
      DEFAULT_WORKERS,
    );
  }
  return inventorySyncPool;
}

async function runInventoryCpuTask(task, payload, fallbackFn) {
  const pool = getInventorySyncCpuPool();
  if (!pool.enabled) {
    return fallbackFn();
  }

  try {
    const result = await pool.run(task, payload);
    if (result == null) {
      return fallbackFn();
    }
    return result;
  } catch (error) {
    console.warn(`[CpuWorkerPool] ${task} failed, falling back to main thread:`, error.message);
    return fallbackFn();
  }
}

module.exports = {
  CpuWorkerPool,
  getInventorySyncCpuPool,
  runInventoryCpuTask,
};
