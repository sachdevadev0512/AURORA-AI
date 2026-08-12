const crypto = require('crypto');
const os = require('os');

const DEFAULT_LEASE_MS = Math.max(
  60_000,
  Number(process.env.SYNC_JOB_LOCK_LEASE_MS || 120_000),
);

let workerId = null;

function getWorkerId() {
  if (!workerId) {
    workerId = `${os.hostname()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  }
  return workerId;
}

function buildLockExpiry(leaseMs = DEFAULT_LEASE_MS) {
  return new Date(Date.now() + leaseMs);
}

function lockClaimFilter(jobId, workerId, now = new Date()) {
  return {
    _id: jobId,
    status: { $in: ['RUNNING', 'STOPPING'] },
    $or: [
      { lockedBy: { $exists: false } },
      { lockedBy: null },
      { lockExpiresAt: { $lte: now } },
      { lockedBy: workerId },
    ],
  };
}

async function tryAcquireJobLock(Model, jobId, workerId = getWorkerId(), leaseMs = DEFAULT_LEASE_MS) {
  const now = new Date();
  const job = await Model.findById(jobId).select('lockedBy lockExpiresAt lockGeneration').lean();
  if (!job) return null;

  const sameWorker = job.lockedBy === workerId;
  const expired = !job.lockExpiresAt || new Date(job.lockExpiresAt) <= now;
  const unowned = !job.lockedBy;
  let lockGeneration = Number(job.lockGeneration) || 0;
  if (!sameWorker && (unowned || expired)) {
    lockGeneration += 1;
  }

  return Model.findOneAndUpdate(
    lockClaimFilter(jobId, workerId, now),
    {
      $set: {
        lockedBy: workerId,
        lockExpiresAt: buildLockExpiry(leaseMs),
        lockGeneration,
        updatedAt: now,
      },
    },
    { new: true },
  );
}

async function renewJobLock(
  Model,
  jobId,
  workerId = getWorkerId(),
  lockGeneration = null,
  leaseMs = DEFAULT_LEASE_MS,
) {
  const filter = {
    _id: jobId,
    lockedBy: workerId,
    status: { $in: ['RUNNING', 'STOPPING'] },
  };

  if (lockGeneration != null && lockGeneration > 0) {
    filter.lockGeneration = lockGeneration;
  }

  const lockExpiresAt = buildLockExpiry(leaseMs);
  return Model.findOneAndUpdate(
    filter,
    {
      $set: {
        lockExpiresAt,
        updatedAt: new Date(),
      },
    },
    { new: true },
  );
}

async function releaseJobLock(Model, jobId, workerId = getWorkerId()) {
  return Model.findOneAndUpdate(
    {
      _id: jobId,
      lockedBy: workerId,
    },
    {
      $set: {
        lockedBy: null,
        lockExpiresAt: null,
        updatedAt: new Date(),
      },
    },
  );
}

async function findRemoteActiveJob(Model, sellerId, workerId = getWorkerId()) {
  return Model.findOne({
    sellerId,
    status: 'RUNNING',
    stopRequested: { $ne: true },
    lockedBy: { $nin: [null, workerId] },
    lockExpiresAt: { $gt: new Date() },
  })
    .sort({ startedAt: -1 })
    .lean();
}

function startLockHeartbeat(Model, jobId, workerId, lockGeneration, onLost, leaseMs = DEFAULT_LEASE_MS) {
  const intervalMs = Math.max(15_000, Math.floor(leaseMs / 4));
  const timer = setInterval(async () => {
    try {
      const renewed = await renewJobLock(Model, jobId, workerId, lockGeneration, leaseMs);
      if (!renewed) {
        clearInterval(timer);
        onLost?.();
      }
    } catch (error) {
      console.warn('[SyncLock] Heartbeat renew failed:', error.message);
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  DEFAULT_LEASE_MS,
  getWorkerId,
  tryAcquireJobLock,
  renewJobLock,
  releaseJobLock,
  findRemoteActiveJob,
  lockClaimFilter,
  startLockHeartbeat,
};
