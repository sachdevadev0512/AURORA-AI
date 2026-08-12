const CONNECTIVITY_ERROR_NAMES = new Set([
  'MongoServerSelectionError',
  'MongoStalePrimaryError',
  'MongoNetworkError',
  'MongoTopologyClosedError',
  'MongoTimeoutError',
]);

function isMongoConnectivityError(error) {
  if (!error) return false;

  if (CONNECTIVITY_ERROR_NAMES.has(error.name)) {
    return true;
  }

  const message = String(error.message || '');
  if (
    message.includes('primary marked stale') ||
    message.includes('ReplicaSetNoPrimary') ||
    message.includes('server monitor timeout') ||
    message.includes('interrupted due to server monitor timeout')
  ) {
    return true;
  }

  if (error.cause) {
    return isMongoConnectivityError(error.cause);
  }

  return false;
}

module.exports = { isMongoConnectivityError };
