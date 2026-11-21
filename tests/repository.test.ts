import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { openLedger, makeRow, change, filtered, type Transaction } from '../src/repository'
import { interpret, period } from '../src/domain'

const room = 'day:2026-11-22'

it('keeps the draft across reloads and writes the completed group once', async () => {
  const owner = crypto.randomUUID()
  let ledger = await openLedger(owner)
  const draft = interpret('ซื้อขนม', '2026-11-22')
  if (draft.kind !== 'clarify') throw Error(draft.kind)
  await ledger.send(room, 'ซื้อขนม', draft, '2026-11-22')
  ledger.close()
  ledger = await openLedger(owner)
  const saved = await ledger.read()
  const answer = interpret('35', '2026-11-22', saved.drafts[room].items)
  await ledger.send(room, '35', answer, '2026-11-22', saved.drafts[room].id)
  await expect(ledger.send(room, '35', answer, '2026-11-22', saved.drafts[room].id)).rejects.toThrow()
  expect((await ledger.read()).items).toMatchObject([{ data: { amount: 3500 } }])
  expect(await ledger.pending()).toHaveLength(2)
  expect((await (await openLedger('other-' + owner)).read()).items).toHaveLength(0)
})

it('does not undo a changed group and keeps corrections and images out of sync', async () => {
  const db = await openLedger(crypto.randomUUID())
  const intent = interpret('ซื้อขนม 50 และซื้อกาแฟ 70', '2026-11-22')
  const messageId = await db.send(room, 'ซื้อขนม 50 และซื้อกาแฟ 70', intent, '2026-11-22')
  const item = (await db.read()).items.find((entry) => entry.data.amount === 5000)!
  await db.edit(item, { ...item.data, amount: 6000 }, true, new Blob(['image']))
  await expect(db.undo(messageId)).rejects.toThrow()
  expect((await db.read()).items).toHaveLength(2)
  expect((await db.read()).logs[0]).toMatchObject({
    before: { amount: 5000 },
    after: { amount: 6000 },
    flagged: true,
  })
  expect(JSON.stringify(await db.pending())).not.toContain('flagged')
  expect(await db.image(item.id)).toBeInstanceOf(Blob)
})

it('reconciles an accepted operation pulled before its retry and resolves conflict as a group', async () => {
  const ledger = await openLedger(crypto.randomUUID())
  const id = await ledger.send(room, 'ซื้อขนม 50', interpret('ซื้อขนม 50', '2026-11-22'), '2026-11-22')
  const [op] = await ledger.pending()
  await ledger.merge(
    op.changes.map((entry) => entry.row),
    '1',
  )
  await ledger.ack(
    op,
    op.changes.map((entry) => entry.row),
  )
  expect(await ledger.pending()).toHaveLength(0)
  const [item] = (await ledger.read()).items
  const deleted = { ...item, revision: 2, deletedAt: new Date().toISOString() }
  await ledger.merge([deleted], '2')
  await expect(ledger.undo(id)).rejects.toThrow()
  await expect(ledger.edit(item, { ...item.data, amount: 6000 })).rejects.toThrow()
  const row = makeRow('transaction', item.data) as Transaction
  await ledger.commit([change(row)])
  const [pending] = await ledger.pending()
  await ledger.reject(pending)
  expect((await ledger.read()).conflicts).toHaveLength(1)
  await ledger.resolve(pending, false)
  expect((await ledger.read()).items).toHaveLength(0)
})

it('rebases later offline edits after keeping a conflicted local change', async () => {
  const ledger = await openLedger(crypto.randomUUID())
  await ledger.send(room, 'ซื้อขนม 50', interpret('ซื้อขนม 50', '2026-11-22'), '2026-11-22')
  const [initial] = await ledger.pending()
  await ledger.ack(
    initial,
    initial.changes.map(({ row }) => row),
  )
  const [entry] = (await ledger.read()).items
  await ledger.edit(entry, { ...entry.data, amount: 6000 })
  await ledger.edit((await ledger.read()).items[0], { ...entry.data, amount: 6500 })
  await ledger.merge([{ ...entry, revision: 5, deletedAt: new Date().toISOString() }], '5')
  await ledger.reject((await ledger.pending())[0])
  await ledger.resolve((await ledger.pending())[0], true)
  expect((await ledger.pending()).map(({ changes }) => changes[0].expected)).toEqual([5, 6])
  expect((await ledger.read()).items[0]).toMatchObject({
    revision: 7,
    deletedAt: null,
    data: { amount: 6500 },
  })
})

it('updates totals when a transaction changes month and removes a separate untouched batch', async () => {
  const ledger = await openLedger('guest-' + crypto.randomUUID())
  const msg = await ledger.send(room, 'ซื้อขนม 50', interpret('ซื้อขนม 50', '2026-11-22'), '2026-11-22')
  const added = (await ledger.read()).items[0]
  await ledger.edit(added, { ...added.data, date: '2026-10-31', amount: 6000 })
  await expect(ledger.undo(msg)).rejects.toThrow()
  const secondMessage = await ledger.send(
    room,
    'ซื้อกาแฟ 70',
    interpret('ซื้อกาแฟ 70', '2026-11-22'),
    '2026-11-22',
  )
  expect(
    filtered((await ledger.read()).items, period('2026-11-22', 'month')).map((row) => row.data.amount),
  ).toEqual([7000])
  await ledger.undo(secondMessage)
  expect(filtered((await ledger.read()).items, period('2026-11-22', 'month'))).toHaveLength(0)
  expect(
    filtered((await ledger.read()).items, period('2026-11-22', 'month', -1)).map(
      (row) => row.data.amount,
    ),
  ).toEqual([6000])
})

it('exports ledger data from IndexedDB and restores it without overwriting existing IDs', async () => {
  const guest = await openLedger('guest')
  const destination = await openLedger(crypto.randomUUID())
  try {
    await guest.send(
      room,
      'ซื้อขนม 50 และซื้อกาแฟ 70',
      interpret('ซื้อขนม 50 และซื้อกาแฟ 70', '2026-11-22'),
      '2026-11-22',
    )
    await guest.setBudget('2026-11-01', 200000)
    const { items } = await guest.read()
    const edited = items.find((row) => row.data.amount === 5000)!
    await guest.edit(edited, { ...edited.data, amount: 6000 }, true, new Blob(['private slip']))
    await guest.remove(items.find((row) => row.data.amount === 7000)!)
    expect(await guest.pending()).toEqual([])
    const json = JSON.stringify(await guest.exportTransfer())
    expect(json).not.toContain('private slip')
    expect(json).not.toContain('"flagged"')
    expect(await destination.importTransfer(JSON.parse(json))).toMatchObject({ transactions: 1 })
    const result = await destination.read()
    expect(result.items[0]).toMatchObject({ id: edited.id, data: { amount: 6000 } })
    expect(result.budgets[0].data.amount).toBe(200000)
    expect(result.messages).toHaveLength(2)
    expect(result.logs).toHaveLength(0)
    expect(await destination.image(edited.id)).toBeUndefined()
    await destination.edit(result.items[0], { ...result.items[0].data, amount: 9000 })
    expect(await destination.importTransfer(JSON.parse(json))).toEqual({ transactions: 0, added: 0 })
    expect((await destination.read()).items[0].data.amount).toBe(9000)
  } finally {
    guest.close()
    destination.close()
  }
})

it('rejects an invalid version or a dangling relationship before creating any rows', async () => {
  const ledger = await openLedger(crypto.randomUUID())
  try {
    const invalid = {
      format: 'my-financial-transfer',
      version: 1,
      rows: [makeRow('message', { roomId: 'room:day:2026-11-22', role: 'user', text: 'ซื้อขนม 50' })],
    }
    await expect(ledger.importTransfer(invalid)).rejects.toThrow()
    await expect(ledger.importTransfer({ ...invalid, version: 2, rows: [] })).rejects.toThrow()
    expect((await ledger.read()).messages).toHaveLength(0)
    expect(await ledger.pending()).toHaveLength(0)
  } finally {
    ledger.close()
  }
})
