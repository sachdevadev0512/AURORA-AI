function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

module.exports = {
  yieldToEventLoop,
};
