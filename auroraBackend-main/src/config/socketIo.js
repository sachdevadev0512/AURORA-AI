const mongoose = require('mongoose');
const { createAdapter } = require('@socket.io/mongo-adapter');

const ADAPTER_COLLECTION = process.env.SOCKET_IO_ADAPTER_COLLECTION || 'socketio_adapter_events';

function useMongoAdapter() {
  return String(process.env.SOCKET_IO_ADAPTER || 'mongo').toLowerCase() !== 'memory';
}

async function ensureAdapterCollection(db) {
  try {
    await db.createCollection(ADAPTER_COLLECTION, {
      capped: true,
      size: 1e6,
    });
  } catch (error) {
    const message = String(error?.message || '');
    if (!message.includes('already exists') && error?.code !== 48) {
      throw error;
    }
  }

  const collection = db.collection(ADAPTER_COLLECTION);
  await collection.createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 3600, background: true },
  ).catch(() => {});

  return collection;
}

/**
 * Attach a cross-instance Socket.IO adapter backed by MongoDB change streams.
 * Requires a replica set (MongoDB Atlas qualifies). Falls back to the default
 * in-memory adapter when disabled or unavailable.
 */
async function attachSocketIoAdapter(io) {
  if (!useMongoAdapter()) {
    console.log('[Socket.IO] Using in-memory adapter (SOCKET_IO_ADAPTER=memory)');
    return { mode: 'memory' };
  }

  if (mongoose.connection.readyState !== 1) {
    console.warn('[Socket.IO] MongoDB not connected; using in-memory adapter');
    return { mode: 'memory', reason: 'mongo_not_ready' };
  }

  try {
    const collection = await ensureAdapterCollection(mongoose.connection.db);
    io.adapter(
      createAdapter(collection, {
        addCreatedAtField: true,
      }),
    );
    console.log(`[Socket.IO] MongoDB adapter enabled on collection "${ADAPTER_COLLECTION}"`);
    return { mode: 'mongo', collection: ADAPTER_COLLECTION };
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes('replica set') || message.includes('$changeStream')) {
      console.warn(
        '[Socket.IO] MongoDB adapter requires a replica set. Using in-memory adapter.',
      );
      return { mode: 'memory', reason: 'replica_set_required' };
    }

    console.warn('[Socket.IO] Failed to attach Mongo adapter:', message);
    return { mode: 'memory', reason: 'adapter_error' };
  }
}

module.exports = {
  attachSocketIoAdapter,
  ADAPTER_COLLECTION,
};
