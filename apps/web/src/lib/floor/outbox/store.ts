import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { OutboxCommand, OutboxStore, RejectedCommand } from './types';

interface OutboxDb extends DBSchema {
  outbox: { key: number; value: OutboxCommand; indexes: { client_uuid: string } };
  rejected: { key: string; value: RejectedCommand };
}

export const OUTBOX_DB_NAME = 'dayson-floor-outbox';

/** IndexedDB store: `outbox` ordered by auto-increment seq, `rejected` by client_uuid. */
export function createIdbOutboxStore(dbName: string = OUTBOX_DB_NAME): OutboxStore {
  let dbPromise: Promise<IDBPDatabase<OutboxDb>> | null = null;
  const db = () => {
    if (!dbPromise) {
      dbPromise = openDB<OutboxDb>(dbName, 1, {
        upgrade(database) {
          const outbox = database.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
          outbox.createIndex('client_uuid', 'client_uuid', { unique: true });
          database.createObjectStore('rejected', { keyPath: 'client_uuid' });
        },
      });
    }
    return dbPromise;
  };

  return {
    async add(command) {
      const database = await db();
      // seq is assigned by the key generator.
      const seq = await database.add('outbox', command as OutboxCommand);
      return { ...command, seq };
    },
    async peek() {
      const cursor = await (await db()).transaction('outbox').store.openCursor();
      return cursor ? cursor.value : null;
    },
    async update(command) {
      const tx = (await db()).transaction('outbox', 'readwrite');
      // Only update a command that is still queued.
      if (await tx.store.get(command.seq)) await tx.store.put(command);
      await tx.done;
    },
    async remove(seq) {
      await (await db()).delete('outbox', seq);
    },
    async reject(command, info) {
      const tx = (await db()).transaction(['outbox', 'rejected'], 'readwrite');
      await tx.objectStore('outbox').delete(command.seq);
      await tx.objectStore('rejected').put({
        ...command,
        rejected_at: info.rejected_at,
        error_code: info.code,
        error_message: info.message,
        acknowledged_at: null,
      });
      await tx.done;
    },
    async count() {
      return (await db()).count('outbox');
    },
    async countUnacknowledgedRejected() {
      const all = await (await db()).getAll('rejected');
      return all.filter((r) => !r.acknowledged_at).length;
    },
    async listQueued() {
      return (await db()).getAll('outbox');
    },
    async listRejected() {
      const all = await (await db()).getAll('rejected');
      return all.sort((a, b) => b.rejected_at.localeCompare(a.rejected_at));
    },
    async acknowledgeRejected(client_uuid, at) {
      const tx = (await db()).transaction('rejected', 'readwrite');
      const row = await tx.store.get(client_uuid);
      if (row && !row.acknowledged_at) await tx.store.put({ ...row, acknowledged_at: at });
      await tx.done;
    },
  };
}
