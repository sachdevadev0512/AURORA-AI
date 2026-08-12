const { parentPort } = require('worker_threads');
const { buildProductDocument } = require('../utils/productDocumentBuilder');
const { parseListingItem, isUnchangedProduct } = require('../utils/listingItemParse');

function serializeForReply(value) {
  return JSON.parse(JSON.stringify(value));
}

parentPort.on('message', (message) => {
  const { id, task, payload } = message;

  try {
    let result;

    if (task === 'buildProductDocument') {
      const { sellerId, fbaItem, catalogItem, extras } = payload;
      result = buildProductDocument(sellerId, fbaItem, catalogItem, extras);
    } else if (task === 'parseListingItem') {
      result = parseListingItem(payload.listingItem, payload.marketplaceId);
    } else if (task === 'isUnchangedProduct') {
      result = isUnchangedProduct(
        payload.fbaItem,
        payload.listingItem,
        payload.existing,
        payload.marketplaceId,
      );
    } else {
      throw new Error(`Unknown CPU worker task: ${task}`);
    }

    parentPort.postMessage({ id, result: serializeForReply(result) });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message || String(error) });
  }
});
