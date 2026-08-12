/**
 * Shared control-plane helpers for persisted sync jobs (inventory / orders).
 */

function clearStopFlag(stopFlags, userId) {
  stopFlags.delete(String(userId));
}

async function refreshStopFromDb(JobModel, stopFlags, jobId, userId, abortController) {
  const job = await JobModel.findById(jobId).select('stopRequested status').lean();
  if (job?.stopRequested || job?.status === 'STOPPING') {
    stopFlags.set(String(userId), true);
    abortController.abort();
    return true;
  }
  return false;
}

function createAbortHelpers(stopFlags, userId, abortController, refreshFn) {
  const id = String(userId);
  const shouldAbort = () =>
    abortController.signal.aborted || stopFlags.get(id) === true;

  const shouldAbortAsync = async () => {
    await refreshFn();
    return shouldAbort();
  };

  return { shouldAbort, shouldAbortAsync };
}

function abortSessionByJobId(sessions, jobId) {
  for (const session of sessions.values()) {
    if (session.jobId === String(jobId)) {
      session.abortController.abort();
      return true;
    }
  }
  return false;
}

module.exports = {
  clearStopFlag,
  refreshStopFromDb,
  createAbortHelpers,
  abortSessionByJobId,
};
