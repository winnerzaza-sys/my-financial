import { openDB, type DBSchema } from 'idb'
import { makeTransfer, readTransfer } from './transfer'
import {
  inPeriod,
  period,
  validItem,
  type DraftItem,
  type Intent,
  type TransactionInput,
} from './domain'

interface Payloads {
  room: { key: string; range: string; start: string }
  message: {
    roomId: string
    role: 'user' | 'assistant'
    text: string
    source?: string
    interpretation?: unknown
    model?: string
    filter?: Filter
  }
  transaction: TransactionInput
  budget: { month: string; amount: number }
  link: { messageId: string; transactionId: string; revision: number; position?: number }
}
export type Filter = {
  start: string
  end: string
  category?: TransactionInput['category']
  metric?: 'income' | 'expense' | 'net'
}
type Entity = keyof Payloads
type LedgerRow<K extends Entity> = {
  id: string
  entity: K
  data: Payloads[K]
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  revision: number
}
export type Row = { [K in Entity]: LedgerRow<K> }[Entity]
export type Transaction = LedgerRow<'transaction'>
export type ChatMessage = LedgerRow<'message'>
export type Draft = {
  id: string
  source: string
  items: DraftItem[]
  model?: string
  interpretation?: unknown
  question: string
}
export type Correction = {
  id: string
  transactionId: string
  source?: string
  interpretation?: unknown
  model?: string
  before: TransactionInput
  after: TransactionInput
  flagged: boolean
  at: string
}
export type Change = { expected: number; row: Row }
export type Operation = { id: string; changes: Change[]; status?: 'conflict' }

interface Storage extends DBSchema {
  rows: { key: string; value: Row }
  remote: { key: string; value: Row }
  outbox: { key: number; value: Operation; indexes: { operation: string } }
  drafts: { key: string; value: Draft }
  logs: { key: string; value: Correction }
  images: { key: string; value: Blob }
  meta: { key: string; value: string }
}
export function makeRow<K extends Entity>(
  entity: K,
  data: Payloads[K],
  id: string = crypto.randomUUID(),
): LedgerRow<K> {
  const now = new Date().toISOString()
  return { id, entity, data, revision: 1, createdAt: now, updatedAt: now, deletedAt: null }
}
export const change = (row: Row): Change => ({ expected: row.revision - 1, row })
const updated = <T extends Row>(row: T, patch: Partial<T>): T => ({
  ...row,
  ...patch,
  revision: row.revision + 1,
  updatedAt: new Date().toISOString(),
})
const alive = (row: Row) => !row.deletedAt
const operation = (changes: Change[]): Operation => ({ id: crypto.randomUUID(), changes })
export const roomKey = (range: string, start: string) => `${range}:${start}`
const roomId = (key: string) => `room:${key}`
const budgetId = (month: string) => `budget:${month}`
const stale = () => new Error('รายการเปลี่ยนแล้ว กรุณาเปิดข้อมูลล่าสุดแล้วลองอีกครั้ง')

export async function openLedger(owner: string) {
  const db = await openDB<Storage>(`financial-v1:${owner}`, 1, {
    upgrade(database) {
      database.createObjectStore('rows', { keyPath: 'id' })
      database.createObjectStore('remote', { keyPath: 'id' })
      database
        .createObjectStore('outbox', { autoIncrement: true })
        .createIndex('operation', 'id', { unique: true })
      for (const name of ['drafts', 'logs', 'images', 'meta'] as const) database.createObjectStore(name)
    },
  })
  const bus =
    typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(`financial:${owner}`)
      : undefined
  const listeners = new Set<() => void>()
  if (bus) bus.onmessage = () => listeners.forEach((listener) => listener())
  function notify() {
    listeners.forEach((listener) => listener())
    bus?.postMessage(null)
  }
  async function commit(
    changes: Change[],
    options?: {
      draft?: { key: string; previous?: string; value: Draft | null }
      log?: Correction
      image?: { id: string; blob: Blob }
    },
  ) {
    const tx = db.transaction(['rows', 'outbox', 'drafts', 'logs', 'images'], 'readwrite')
    try {
      if (options?.draft) {
        const { key, previous, value } = options.draft
        if ((await tx.objectStore('drafts').get(key))?.id !== previous) throw stale()
        if (value) await tx.objectStore('drafts').put(value, key)
        else await tx.objectStore('drafts').delete(key)
      }
      const pending = await tx.objectStore('outbox').getAll()
      const locked = new Set(
        pending
          .filter((op) => op.status === 'conflict')
          .flatMap((op) => op.changes.map((entry) => entry.row.id)),
      )
      for (const entry of changes) {
        const existing = await tx.objectStore('rows').get(entry.row.id)
        if (locked.has(entry.row.id) || (existing?.revision ?? 0) !== entry.expected) throw stale()
        await tx.objectStore('rows').put(entry.row)
      }
      if (owner !== 'guest' && changes.length) await tx.objectStore('outbox').add(operation(changes))
      if (options?.log) await tx.objectStore('logs').put(options.log, options.log.id)
      if (options?.image) await tx.objectStore('images').put(options.image.blob, options.image.id)
      await tx.done
      notify()
    } catch (error) {
      try {
        tx.abort()
      } catch {
        /* transaction already rolled back */
      }
      await tx.done.catch(() => undefined)
      throw error
    }
  }
  async function rowsForRoom(key: string): Promise<Change[]> {
    const [range, start] = key.split(':')
    const id = roomId(key)
    return (await db.get('rows', id)) ? [] : [change(makeRow('room', { key, range, start }, id))]
  }
  async function read() {
    const tx = db.transaction(['rows', 'drafts', 'logs', 'outbox'])
    const [rows, draftKeys, drafts, logs, pending] = await Promise.all([
      tx.objectStore('rows').getAll(),
      tx.objectStore('drafts').getAllKeys(),
      tx.objectStore('drafts').getAll(),
      tx.objectStore('logs').getAll(),
      tx.objectStore('outbox').getAll(),
    ])
    await tx.done
    const active = rows.filter(alive)
    return {
      items: active.filter((row) => row.entity === 'transaction'),
      messages: active
        .filter((row) => row.entity === 'message')
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
      budgets: active.filter((row) => row.entity === 'budget'),
      links: active.filter((row) => row.entity === 'link'),
      drafts: Object.fromEntries(draftKeys.map((key, index) => [key, drafts[index]])),
      logs,
      pending: pending.length,
      conflicts: pending.filter((op) => op.status === 'conflict'),
    }
  }
  async function send(
    key: string,
    text: string,
    intent: Intent,
    today: string,
    draftId?: string,
    ai?: { model: string; interpretation: unknown },
  ) {
    const draft = await db.get('drafts', key)
    const changes = await rowsForRoom(key)
    const request = makeRow('message', { roomId: roomId(key), role: 'user', text })
    const reply = makeRow('message', {
      roomId: roomId(key),
      role: 'assistant',
      text: '',
      source: draft ? `${draft.source}\n${text}` : text,
      model: draft?.model ?? ai?.model,
      interpretation: draft?.interpretation ?? ai?.interpretation,
    })
    // Keep a deterministic conversation order even when both writes share a millisecond.
    reply.createdAt = new Date(Date.parse(request.createdAt) + 1).toISOString()
    reply.updatedAt = reply.createdAt
    let nextDraft: Draft | null = null
    if (intent.kind === 'record') {
      for (const [position, input] of intent.items.entries()) {
        if (!validItem(input)) throw new Error('กรุณาตรวจข้อมูลรายการ')
        const entry = makeRow('transaction', input)
        changes.push(
          change(entry),
          change(
            makeRow('link', {
              messageId: reply.id,
              transactionId: entry.id,
              revision: entry.revision,
              position,
            }),
          ),
        )
      }
    } else if (intent.kind === 'clarify') {
      reply.data.text = intent.question
      nextDraft = {
        id: crypto.randomUUID(),
        source: reply.data.source!,
        items: intent.items,
        model: reply.data.model,
        interpretation: reply.data.interpretation,
        question: intent.question,
      }
    } else if (intent.kind === 'query') {
      reply.data.filter = {
        ...period(today, intent.range, intent.offset),
        category: intent.category,
        metric: intent.metric,
      }
      reply.data.text =
        intent.category ?? { expense: 'รายจ่าย', income: 'เงินเข้า', net: 'ยอดสุทธิ' }[intent.metric]
    } else if (intent.kind === 'budget') {
      changes.push(await budgetChange(intent.month, intent.amount))
      reply.data.text =
        'บันทึกงบเดือน ' +
        intent.month.slice(0, 7) +
        ' · ' +
        (intent.amount / 100).toLocaleString('th-TH') +
        ' บาท'
    } else reply.data.text = 'ลองระบุรายการและยอดเงิน เช่น ซื้อกาแฟ 70 หรือเลือกกรอกเอง'
    await commit([...changes, change(request), change(reply)], {
      draft: { key, previous: draftId, value: nextDraft },
    })
    return reply.id
  }
  async function add(key: string, input: TransactionInput, image?: Blob) {
    if (!validItem(input)) throw new Error('กรุณาตรวจข้อมูลรายการ')
    const rows = await rowsForRoom(key)
    const item = makeRow('transaction', input)
    const reply = makeRow('message', {
      roomId: roomId(key),
      role: 'assistant',
      text: '',
      source: image ? 'ตรวจสลิป' : 'กรอกเอง',
    })
    const link = makeRow('link', {
      messageId: reply.id,
      transactionId: item.id,
      revision: item.revision,
    })
    await commit([...rows, change(item), change(reply), change(link)], {
      image: image ? { id: item.id, blob: image } : undefined,
    })
  }
  async function budgetChange(month: string, amount: number) {
    if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(month) || amount < 0 || !Number.isSafeInteger(amount))
      throw new Error('งบไม่ถูกต้อง')
    const row = await db.get('rows', budgetId(month))
    return change(
      row?.entity === 'budget'
        ? updated(row, { data: { month, amount }, deletedAt: null })
        : makeRow('budget', { month, amount }, budgetId(month)),
    )
  }
  async function edit(item: Transaction, input: TransactionInput, flagged = false, image?: Blob) {
    if (!validItem(input)) throw new Error('กรุณาตรวจข้อมูลรายการ')
    const { links, messages } = await read()
    const link = links.find((row) => row.data.transactionId === item.id)
    const message = messages.find((row) => row.id === link?.data.messageId)?.data
    const log: Correction = {
      id: crypto.randomUUID(),
      transactionId: item.id,
      source: message?.source,
      interpretation: message?.interpretation,
      model: message?.model,
      before: item.data,
      after: input,
      flagged,
      at: new Date().toISOString(),
    }
    await commit([change(updated(item, { data: input }))], {
      log,
      image: image ? { id: item.id, blob: image } : undefined,
    })
  }
  async function undo(messageId: string) {
    const snap = await read()
    const links = snap.links.filter((row) => row.data.messageId === messageId)
    if (!links.length) return
    const changes = links.map((link) => {
      const row = snap.items.find((item) => item.id === link.data.transactionId)
      if (!row || row.revision !== link.data.revision) throw stale()
      return change(updated(row, { deletedAt: new Date().toISOString() }))
    })
    await commit(changes)
  }
  async function rebuild(remote: Row[], op?: Operation) {
    const tx = db.transaction(['rows', 'remote', 'outbox'], 'readwrite')
    const keys = new Set(remote.map((row) => row.id))
    for (const row of remote) {
      const current = await tx.objectStore('remote').get(row.id)
      if (!current || current.revision <= row.revision) await tx.objectStore('remote').put(row)
    }
    if (op) {
      const key = await tx.objectStore('outbox').index('operation').getKey(op.id)
      if (key !== undefined) await tx.objectStore('outbox').delete(key)
      for (const entry of op.changes) keys.add(entry.row.id)
    }
    const pending = await tx.objectStore('outbox').getAll()
    for (const id of keys) {
      const optimistic = pending
        .flatMap((item) => item.changes)
        .filter((entry) => entry.row.id === id)
        .at(-1)?.row
      const row = optimistic ?? (await tx.objectStore('remote').get(id))
      if (row) await tx.objectStore('rows').put(row)
      else await tx.objectStore('rows').delete(id)
    }
    await tx.done
  }
  async function resolve(op: Operation, keep: boolean) {
    const tx = db.transaction(['rows', 'remote', 'outbox'], 'readwrite')
    const outbox = tx.objectStore('outbox')
    const key = await outbox.index('operation').getKey(op.id)
    if (key === undefined) {
      await tx.done
      return
    }
    const stored = await outbox.get(key)
    if (stored?.status !== 'conflict') {
      await tx.done
      return
    }
    const keys = new Set(op.changes.map((entry) => entry.row.id))
    const newer = await outbox.getAllKeys(IDBKeyRange.lowerBound(key, true))
    const revisions = new Map<string, number>()
    await outbox.delete(key)
    if (keep) {
      const rebased: Change[] = []
      for (const entry of op.changes) {
        const current = await tx.objectStore('remote').get(entry.row.id)
        if (entry.row.entity === 'room' && current && !current.deletedAt) continue
        const expected = current?.revision ?? 0
        rebased.push({
          expected,
          row: { ...entry.row, revision: expected + 1, updatedAt: new Date().toISOString() },
        })
        revisions.set(entry.row.id, expected + 1)
      }
      if (rebased.length) await outbox.put(operation(rebased), key)
    }
    for (const nextKey of newer) {
      const queued = (await outbox.get(nextKey))!
      if (keep) {
        if (!queued.changes.some((entry) => revisions.has(entry.row.id))) continue
        const changes = queued.changes.map((entry) => {
          const expected = revisions.get(entry.row.id)
          if (expected === undefined) return entry
          revisions.set(entry.row.id, expected + 1)
          return { expected, row: { ...entry.row, revision: expected + 1 } }
        })
        await outbox.put(operation(changes), nextKey)
      } else {
        const dependsOnDrop = queued.changes.some(
          ({ row }) =>
            keys.has(row.id) ||
            (row.entity === 'link' &&
              (keys.has(row.data.messageId) || keys.has(row.data.transactionId))) ||
            (row.entity === 'message' && keys.has(row.data.roomId)),
        )
        if (dependsOnDrop) {
          queued.changes.forEach((entry) => keys.add(entry.row.id))
          await outbox.delete(nextKey)
        }
      }
    }
    const optimistic = new Map(
      (await outbox.getAll()).flatMap((item) => item.changes.map(({ row }) => [row.id, row] as const)),
    )
    for (const id of keys) {
      const row = optimistic.get(id) ?? (await tx.objectStore('remote').get(id))
      if (row) await tx.objectStore('rows').put(row)
      else await tx.objectStore('rows').delete(id)
    }
    await tx.done
    notify()
  }
  return {
    owner,
    read,
    send,
    add,
    edit,
    undo,
    commit,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    close() {
      bus?.close()
      db.close()
    },
    async cancelDraft(key: string, previous: string) {
      await commit([], { draft: { key, previous, value: null } })
    },
    async remove(item: Transaction) {
      await commit([change(updated(item, { deletedAt: new Date().toISOString() }))])
    },
    async setBudget(month: string, amount: number) {
      await commit([await budgetChange(month, amount)])
    },
    image: (id: string) => db.get('images', id),
    async exportLogs() {
      return { exportedAt: new Date().toISOString(), corrections: (await read()).logs }
    },
    pending: () => db.getAll('outbox'),
    cursor: async () => (await db.get('meta', 'cursor')) ?? '0',
    async merge(rows: Row[], cursor: string) {
      await rebuild(rows)
      const tx = db.transaction('meta', 'readwrite')
      if (BigInt(cursor) > BigInt((await tx.store.get('cursor')) ?? '0'))
        await tx.store.put(cursor, 'cursor')
      await tx.done
      if (rows.length) notify()
    },
    async ack(op: Operation, rows: Row[]) {
      await rebuild(rows, op)
      notify()
    },
    async reject(op: Operation) {
      const tx = db.transaction('outbox', 'readwrite')
      const key = await tx.store.index('operation').getKey(op.id)
      if (key !== undefined) await tx.store.put({ ...op, status: 'conflict' }, key)
      await tx.done
      notify()
    },
    resolve,
    async remote(op: Operation) {
      return Promise.all(op.changes.map((entry) => db.get('remote', entry.row.id)))
    },
    async exportTransfer() {
      return makeTransfer(await db.getAll('rows'))
    },
    async importTransfer(value: unknown) {
      const rows = readTransfer(value)
      const tx = db.transaction(['rows', 'outbox'], 'readwrite')
      const storage = tx.objectStore('rows')
      const byId = new Map(rows.map((row) => [row.id, row]))
      const inserted = new Set<string>()
      const changes: Change[] = []
      try {
        for (const row of rows) {
          if (await storage.get(row.id)) continue
          if (row.entity === 'message' && (await storage.get(row.data.roomId))?.deletedAt) continue
          if (row.entity === 'link') {
            const item = await storage.get(row.data.transactionId)
            const message = await storage.get(row.data.messageId)
            if (!item || item.deletedAt || !message || message.deletedAt) continue
          }
          const next: Row =
            row.entity === 'link'
              ? {
                  ...row,
                  revision: 1,
                  data: {
                    ...row.data,
                    revision:
                      inserted.has(row.data.transactionId) &&
                      inserted.has(row.data.messageId) &&
                      row.data.revision === byId.get(row.data.transactionId)?.revision
                        ? 1
                        : 0,
                  },
                }
              : { ...row, revision: 1 }
          await storage.put(next)
          inserted.add(row.id)
          changes.push(change(next))
        }
        if (owner !== 'guest') {
          // Keep each RPC batch under the server limit and preserve the dependency order.
          for (let i = 0; i < changes.length; i += 50)
            await tx.objectStore('outbox').add(operation(changes.slice(i, i + 50)))
        }
        await tx.done
      } catch (error) {
        try {
          tx.abort()
        } catch {
          /* transaction already rolled back */
        }
        await tx.done.catch(() => undefined)
        throw error
      }
      if (changes.length) notify()
      return {
        transactions: changes.filter(({ row }) => row.entity === 'transaction').length,
        added: changes.length,
      }
    },
  }
}
export type Ledger = Awaited<ReturnType<typeof openLedger>>
export function filtered(items: Transaction[], filter: Filter) {
  return items.filter(
    ({ data }) => inPeriod(data.date, filter) && (!filter.category || data.category === filter.category),
  )
}
