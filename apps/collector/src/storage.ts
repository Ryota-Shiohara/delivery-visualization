import type { Measurement, Session } from './types';

const DB_NAME = 'delivery-collector-v1';
let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('sessions', { keyPath: 'id' });
        request.result.createObjectStore('measurements', { keyPath: 'measurementId' })
          .createIndex('deliveryId', 'deliveryId');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('別のタブを閉じてから再試行してください。'));
    }).catch(error => { database = undefined; throw error; });
  }
  return database;
}

export async function saveBatch(session: Session, measurements: Measurement[]): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['sessions', 'measurements'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('保存が中断されました。'));
    tx.objectStore('sessions').put(session);
    for (const measurement of measurements) tx.objectStore('measurements').put(measurement);
  });
}

export async function listSessions(): Promise<Session[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('sessions').objectStore('sessions').getAll();
    request.onsuccess = () => resolve((request.result as Session[]).sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
    request.onerror = () => reject(request.error);
  });
}

export async function getMeasurements(deliveryId: string): Promise<Measurement[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('measurements').objectStore('measurements').index('deliveryId').getAll(deliveryId);
    request.onsuccess = () => resolve((request.result as Measurement[]).sort((a, b) => a.measuredAt.localeCompare(b.measuredAt)));
    request.onerror = () => reject(request.error);
  });
}

export function downloadSession(session: Session, measurements: Measurement[]): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify({
    exportVersion: '0.1.0',
    session,
    measurements,
  }, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `collector-${session.mode}-${session.id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
