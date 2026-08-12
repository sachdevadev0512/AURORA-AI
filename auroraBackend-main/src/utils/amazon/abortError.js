function createAbortError() {
  const error = new Error('Sync aborted');
  error.code = 'SYNC_ABORTED';
  return error;
}

module.exports = {
  createAbortError,
};
