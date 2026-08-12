function formatProcessError(reason) {
  if (reason instanceof Error) {
    return {
      message: reason.message,
      stack: reason.stack,
    };
  }

  return {
    message: String(reason),
    stack: undefined,
  };
}

function registerProcessHandlers() {
  process.on('unhandledRejection', (reason) => {
    const { message, stack } = formatProcessError(reason);
    console.error('[Process] Unhandled promise rejection:', message);
    if (stack) {
      console.error(stack);
    }
  });

  process.on('uncaughtException', (err) => {
    console.error('[Process] Uncaught exception:', err.message);
    if (err.stack) {
      console.error(err.stack);
    }
  });
}

module.exports = {
  registerProcessHandlers,
};
