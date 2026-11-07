// The in-process MongoDB the tests run against: one mongod started by mongodb-memory-server-core as a
// single-member replica set (Atlas is a replica set too, so retryable writes behave the same way). It
// listens on the loopback address only, and nothing here reads .env or any MONGODB_* variable. The first
// run downloads the binary (about 800 MB) into a per-user cache, so later runs and git worktrees reuse it.
import os from 'node:os';
import path from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server-core';

/** Same major version as the owner's Atlas cluster. */
export const TEST_MONGODB_VERSION = '8.0.20';
const BINARY_CACHE = path.join(os.homedir(), '.cache', 'mongodb-binaries');

/** @returns {Promise<{ uri: string, stop: () => Promise<void> }>} */
export async function startMongoServer() {
  const replSet = await MongoMemoryReplSet.create({
    binary: { version: TEST_MONGODB_VERSION, downloadDir: BINARY_CACHE },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' },
  });
  return {
    uri: replSet.getUri(),
    async stop() {
      await replSet.stop({ doCleanup: true, force: true });
    },
  };
}
