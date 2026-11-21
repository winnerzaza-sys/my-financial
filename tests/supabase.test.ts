import 'fake-indexeddb/auto'
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { makeRow, change, openLedger, type Change, type Row } from '../src/repository'
import { summarize, interpret } from '../src/domain'

const database = new PGlite()
const owner = '10000000-0000-4000-8000-000000000001'
const another = '10000000-0000-4000-8000-000000000002'
const room = makeRow(
  'room',
  { key: 'day:2026-11-22', range: 'day', start: '2026-11-22' },
  'room:day:2026-11-22',
)
const message = makeRow('message', { roomId: room.id, role: 'assistant', text: '' })
const transaction = makeRow('transaction', {
  name: 'ขนม',
  type: 'expense',
  amount: 5000,
  date: '2026-11-22',
  counted: true,
  category: 'อาหารและเครื่องดื่ม',
  method: 'ไม่ระบุ',
})
const refund = makeRow('transaction', {
  ...transaction.data,
  name: 'เพื่อนคืนค่าข้าว',
  type: 'refund',
  amount: 10000,
  method: 'โอน',
})
const links = [refund, transaction].map((row) =>
  makeRow('link', { messageId: message.id, transactionId: row.id, revision: 1 }),
)
const payload = [room, message, refund, transaction, ...links].map(change)
const setActor = async (actor: string) => {
  await database.exec('set role authenticated')
  await database.query("select set_config('request.jwt.claim.sub',$1,false)", [actor])
}
const apply = async (actor: string, changes: Change[], id: string = crypto.randomUUID()) =>
  (
    await database.query<{ result: { status: string; rows: Row[] } }>(
      'select public.ledger_apply($1,$2,$3::jsonb) as result',
      [actor, id, JSON.stringify(changes)],
    )
  ).rows[0].result
const pull = async (actor: string, cursor = '0') =>
  (
    await database.query<{ result: { rows: Row[]; cursor: string } }>(
      'select public.ledger_pull($1,$2) as result',
      [actor, cursor],
    )
  ).rows[0].result

beforeAll(async () => {
  await database.exec(`
  create role anon;
  create role authenticated;
  create schema auth;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
  grant usage on schema auth to authenticated, anon;
  insert into auth.users values ('${owner}'),('${another}');
  `)
  await database.exec(
    await readFile(new URL('../supabase/migrations/20261122000000_ledger.sql', import.meta.url), 'utf8'),
  )
})
afterAll(async () => {
  await database.close()
})

it('applies an atomic group once, uses a server cursor, and catches stale edits and deletes', async () => {
  await setActor(owner)
  const id: string = crypto.randomUUID()
  const first = await apply(owner, payload, id)
  expect(first.status).toBe('ok')
  expect(await apply(owner, payload, id)).toEqual(first)
  const sync = await pull(owner)
  expect(sync.rows).toHaveLength(6)
  expect(
    summarize(sync.rows.filter((row) => row.entity === 'transaction').map((row) => row.data)).net,
  ).toBe(5000)
  expect(
    (
      await apply(owner, [
        change(room),
        change(makeRow('message', { roomId: room.id, role: 'user', text: 'จากอีกเครื่อง' })),
      ])
    ).status,
  ).toBe('ok')
  const edit = { ...transaction, revision: 2, data: { ...transaction.data, amount: 6000 } }
  expect((await apply(owner, [change(edit)])).status).toBe('ok')
  expect(
    (await apply(owner, [change({ ...transaction, revision: 2, deletedAt: new Date().toISOString() })]))
      .status,
  ).toBe('conflict')
  let delta = await pull(owner, sync.cursor)
  expect(delta.rows.find((row) => row.id === transaction.id)).toMatchObject({
    revision: 2,
    data: { amount: 6000 },
  })
  expect(
    (await apply(owner, [change({ ...edit, revision: 3, deletedAt: new Date().toISOString() })])).status,
  ).toBe('ok')
  delta = await pull(owner, delta.cursor)
  expect(delta.rows[0]).toMatchObject({ id: transaction.id, revision: 3, deletedAt: expect.any(String) })
})

it('isolates reads and rejects cross-owner links and stale account requests without partial writes', async () => {
  await setActor(owner)
  const existing = await database.query('select * from public.chat_messages')
  expect(existing.rows.length).toBeGreaterThan(0)
  await setActor(another)
  expect((await database.query('select * from public.chat_messages')).rows).toHaveLength(0)
  await expect(pull(owner)).rejects.toThrow('account mismatch')
  await expect(apply(owner, payload)).rejects.toThrow('account mismatch')
  const localMessage = makeRow('message', { roomId: room.id, role: 'assistant', text: '' })
  await expect(
    apply(another, [
      change(room),
      change(localMessage),
      change(
        makeRow('link', {
          messageId: localMessage.id,
          transactionId: transaction.id,
          revision: 1,
        }),
      ),
    ]),
  ).rejects.toThrow('invalid link')
  expect((await pull(another)).rows).toHaveLength(0)
  await expect(database.query('delete from public.ledger_rows')).rejects.toThrow('permission denied')
})

it('moves a local JSON export through the account outbox to PostgreSQL with the original IDs', async () => {
  await setActor(another)
  const local = await openLedger('guest')
  const connected = await openLedger(another)
  try {
    await local.send(
      'day:2026-11-22',
      'ซื้อกาแฟ 70',
      interpret('ซื้อกาแฟ 70', '2026-11-22'),
      '2026-11-22',
    )
    await local.setBudget('2026-11-01', 500000)
    const backup = JSON.parse(JSON.stringify(await local.exportTransfer()))
    const original = (await local.read()).items[0]
    await connected.importTransfer(backup)
    for (const pending of await connected.pending()) {
      const result = await apply(another, pending.changes, pending.id)
      expect(result.status).toBe('ok')
      await connected.ack(pending, result.rows)
    }
    expect((await pull(another)).rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: 'transaction',
          id: original.id,
          data: expect.objectContaining({ amount: 7000 }),
        }),
        expect.objectContaining({ entity: 'budget', data: expect.objectContaining({ amount: 500000 }) }),
        expect.objectContaining({
          entity: 'link',
          data: expect.objectContaining({ transactionId: original.id }),
        }),
      ]),
    )
    expect(await connected.importTransfer(backup)).toEqual({ transactions: 0, added: 0 })
    expect(await connected.pending()).toHaveLength(0)
  } finally {
    local.close()
    connected.close()
  }
})
