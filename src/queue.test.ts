import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { closeDbForTests } from './db'
import { countOutbox, listOutbox, saveLog, syncOutbox } from './queue'
import type { LogRow, OutboxEntry, PhotoRow, Remote } from './types'

function entry(id: string, overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id,
    projectId: 'project-1',
    room: 'Living',
    trade: 'False ceiling',
    note: 'Framing done',
    loggedAt: '2026-11-15T05:00:00.000Z',
    photos: [
      { id: `${id}-p1`, blob: new Blob(['a']), mime: 'image/jpeg', ext: 'jpg' },
      { id: `${id}-p2`, blob: new Blob(['b']), mime: 'image/jpeg', ext: 'jpg' },
    ],
    audio: { blob: new Blob(['voice']), mime: 'audio/webm', ext: 'webm' },
    attempts: 0,
    lastError: null,
    ...overrides,
  }
}

/** A stand-in server that records what it receives and can be told to fail. */
function fakeRemote() {
  const files = new Map<string, number>()
  const logs = new Map<string, LogRow>()
  const photos = new Map<string, PhotoRow>()
  const state = { failUploadsContaining: '' as string, failLogs: false }
  const remote: Remote = {
    async uploadFile(path) {
      if (state.failUploadsContaining && path.includes(state.failUploadsContaining)) {
        throw new Error('network down')
      }
      files.set(path, (files.get(path) ?? 0) + 1)
    },
    async upsertLog(row) {
      if (state.failLogs) throw new Error('server refused')
      logs.set(row.id, row)
    },
    async upsertPhotos(rows) {
      for (const r of rows) photos.set(r.id, r)
    },
  }
  return { remote, files, logs, photos, state }
}

beforeEach(async () => {
  await closeDbForTests()
  globalThis.indexedDB = new IDBFactory()
})

describe('saving on the phone', () => {
  it('keeps the log with its photos and voice note', async () => {
    await saveLog(entry('log-1'))
    expect(await countOutbox()).toBe(1)
    const [saved] = await listOutbox()
    expect(saved.photos).toHaveLength(2)
    expect(saved.audio).not.toBeNull()
    expect(saved.note).toBe('Framing done')
  })

  it('lists logs oldest first', async () => {
    await saveLog(entry('later', { loggedAt: '2026-11-15T09:00:00.000Z' }))
    await saveLog(entry('earlier', { loggedAt: '2026-11-15T07:00:00.000Z' }))
    expect((await listOutbox()).map((e) => e.id)).toEqual(['earlier', 'later'])
  })
})

describe('uploading', () => {
  it('sends files and records, then clears the phone', async () => {
    const server = fakeRemote()
    await saveLog(entry('log-1'))
    const result = await syncOutbox(server.remote)

    expect(result).toEqual({ uploaded: 1, failed: 0 })
    expect(await countOutbox()).toBe(0)
    expect([...server.files.keys()].sort()).toEqual([
      'project-1/log-1/log-1-p1.jpg',
      'project-1/log-1/log-1-p2.jpg',
      'project-1/log-1/voice.webm',
    ])
    expect(server.logs.get('log-1')?.audio_path).toBe('project-1/log-1/voice.webm')
    expect(server.logs.get('log-1')?.project_id).toBe('project-1')
    expect(server.photos.size).toBe(2)
  })

  it('keeps a log on the phone when an upload fails, and records why', async () => {
    const server = fakeRemote()
    server.state.failUploadsContaining = 'p2'
    await saveLog(entry('log-1'))
    const result = await syncOutbox(server.remote)

    expect(result).toEqual({ uploaded: 0, failed: 1 })
    expect(await countOutbox()).toBe(1)
    const [kept] = await listOutbox()
    expect(kept.attempts).toBe(1)
    expect(kept.lastError).toBe('network down')
    expect(kept.photos).toHaveLength(2)
    // No record on the server until every file is up.
    expect(server.logs.size).toBe(0)
  })

  it('a retry finishes the job without creating duplicates', async () => {
    const server = fakeRemote()
    server.state.failLogs = true
    await saveLog(entry('log-1'))
    await syncOutbox(server.remote)
    expect(await countOutbox()).toBe(1)

    server.state.failLogs = false
    const second = await syncOutbox(server.remote)

    expect(second).toEqual({ uploaded: 1, failed: 0 })
    expect(await countOutbox()).toBe(0)
    expect(server.logs.size).toBe(1)
    expect(server.photos.size).toBe(2)
    // Same three paths, written twice: the retry overwrote, it did not add.
    expect(server.files.size).toBe(3)
    expect(server.files.get('project-1/log-1/voice.webm')).toBe(2)
  })

  it('one bad log does not block the others', async () => {
    const server = fakeRemote()
    server.state.failUploadsContaining = 'bad'
    await saveLog(entry('bad', { loggedAt: '2026-11-15T06:00:00.000Z' }))
    await saveLog(entry('good', { loggedAt: '2026-11-15T07:00:00.000Z' }))
    const result = await syncOutbox(server.remote)

    expect(result).toEqual({ uploaded: 1, failed: 1 })
    expect((await listOutbox()).map((e) => e.id)).toEqual(['bad'])
    expect(server.logs.has('good')).toBe(true)
  })

  it('a log with no photos or voice still uploads', async () => {
    const server = fakeRemote()
    await saveLog(entry('plain', { photos: [], audio: null }))
    const result = await syncOutbox(server.remote)

    expect(result).toEqual({ uploaded: 1, failed: 0 })
    expect(server.files.size).toBe(0)
    expect(server.logs.get('plain')?.audio_path).toBeNull()
  })

  it('two uploads started together run once', async () => {
    const server = fakeRemote()
    await saveLog(entry('log-1'))
    const [a, b] = await Promise.all([syncOutbox(server.remote), syncOutbox(server.remote)])

    expect(a).toEqual({ uploaded: 1, failed: 0 })
    expect(b).toEqual(a)
    expect(server.files.get('project-1/log-1/voice.webm')).toBe(1)
  })
})
