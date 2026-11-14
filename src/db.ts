import { openDB, type IDBPDatabase } from 'idb'

let dbPromise: Promise<IDBPDatabase> | null = null

/** The phone's own storage: an outbox of unsent logs and a small cache. */
export function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB('studio-tool', 1, {
      upgrade(db) {
        db.createObjectStore('outbox', { keyPath: 'id' })
        db.createObjectStore('cache')
      },
    })
  }
  return dbPromise
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
  const db = await getDb()
  await db.put('cache', value, key)
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  const db = await getDb()
  return (await db.get('cache', key)) as T | undefined
}

/** Tests only: forget the open connection so each test starts clean. */
export async function closeDbForTests(): Promise<void> {
  if (dbPromise) (await dbPromise).close()
  dbPromise = null
}
