/**
 * Shared per-user interval scheduler primitives used by fee/repricer/ads live sync.
 */

function createPerUserSchedulerState() {
  return {
    userTimers: new Map(),
    reconcileTimer: null,
    started: false,
  };
}

function registerUserInterval(state, userId, intervalMs, onTick) {
  const id = String(userId);
  if (state.userTimers.has(id)) return false;

  const timerId = setInterval(() => {
    Promise.resolve()
      .then(() => onTick(id))
      .catch(() => {});
  }, intervalMs);

  state.userTimers.set(id, timerId);
  return true;
}

function unregisterUserInterval(state, userId) {
  const id = String(userId);
  const timerId = state.userTimers.get(id);
  if (!timerId) return false;
  clearInterval(timerId);
  state.userTimers.delete(id);
  return true;
}

/**
 * Ensure timers match the eligible user set.
 * `registerFn(userId)` / `unregisterFn(userId)` are domain-specific.
 */
async function reconcileUserTimers(state, eligibleIds, registerFn, unregisterFn) {
  const eligible = eligibleIds instanceof Set ? eligibleIds : new Set(eligibleIds);

  for (const userId of eligible) {
    if (!state.userTimers.has(userId)) {
      registerFn(userId);
    }
  }

  for (const userId of [...state.userTimers.keys()]) {
    if (!eligible.has(userId)) {
      unregisterFn(userId);
    }
  }

  return {
    eligibleUsers: eligible.size,
    registeredUsers: state.userTimers.size,
  };
}

function startReconcileLoop(state, reconcileMs, reconcileFn, logPrefix = 'LiveSync') {
  if (state.reconcileTimer) return;
  state.reconcileTimer = setInterval(() => {
    Promise.resolve()
      .then(() => reconcileFn())
      .catch((err) => {
        console.error(`[${logPrefix}] Reconcile failed:`, err.message);
      });
  }, reconcileMs);
}

function stopReconcileLoop(state) {
  if (!state.reconcileTimer) return;
  clearInterval(state.reconcileTimer);
  state.reconcileTimer = null;
}

function stopAllUserTimers(state, unregisterFn) {
  stopReconcileLoop(state);
  for (const userId of [...state.userTimers.keys()]) {
    unregisterFn(userId);
  }
  state.started = false;
}

module.exports = {
  createPerUserSchedulerState,
  registerUserInterval,
  unregisterUserInterval,
  reconcileUserTimers,
  startReconcileLoop,
  stopReconcileLoop,
  stopAllUserTimers,
};
