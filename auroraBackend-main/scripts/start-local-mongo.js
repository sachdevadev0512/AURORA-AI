const { MongoMemoryServer } = require('mongodb-memory-server');

async function main() {
  console.log('[MongoServer] Downloading/starting local standalone MongoDB on port 27017...');
  const mongod = await MongoMemoryServer.create({
    instance: {
      port: 27017,
      dbName: 'aurora',
    },
  });

  const uri = mongod.getUri();
  console.log(`[MongoServer] Local MongoDB successfully running at: ${uri}`);
}

main().catch((err) => {
  console.error('[MongoServer] Failed to start local MongoDB:', err);
  process.exit(1);
});
