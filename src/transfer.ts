import { categories, validDate, validItem, type TransactionInput } from './domain'
import type { Row } from './repository'

const format = 'my-financial-transfer'
const order = { room: 0, transaction: 1, budget: 2, message: 3, link: 4 }
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const date = (value: unknown): value is string => typeof value === 'string' && validDate(value)
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value))
const encoder = new TextEncoder()
export const transferFileLimit = 50 * 1024 * 1024

function canTransfer(row: unknown): row is Row {
  if (
    !object(row) ||
    typeof row.id !== 'string' ||
    typeof row.revision !== 'number' ||
    !Number.isInteger(row.revision) ||
    row.revision < 1 ||
    !timestamp(row.createdAt) ||
    !timestamp(row.updatedAt) ||
    row.deletedAt !== null ||
    !object(row.data) ||
    encoder.encode(JSON.stringify(row.data)).length > 44000
  )
    return false

  const data = row.data
  const slip = data.slip
  switch (row.entity) {
    case 'room':
      return (
        (data.range === 'day' || data.range === 'week' || data.range === 'month') &&
        date(data.start) &&
        data.key === `${data.range}:${data.start}` &&
        row.id === 'room:' + data.key
      )
    case 'budget':
      return (
        date(data.month) &&
        data.month.endsWith('-01') &&
        row.id === 'budget:' + data.month &&
        typeof data.amount === 'number' &&
        Number.isSafeInteger(data.amount) &&
        data.amount >= 0
      )
    case 'transaction':
      return (
        uuid.test(row.id) &&
        typeof data.name === 'string' &&
        date(data.date) &&
        (data.unit === undefined || typeof data.unit === 'string') &&
        (slip === undefined ||
          (object(slip) &&
            ['reference', 'time', 'party'].every(
              (field) => slip[field] === undefined || typeof slip[field] === 'string',
            ))) &&
        validItem(data as unknown as TransactionInput)
      )
    case 'message':
      return (
        uuid.test(row.id) &&
        typeof data.roomId === 'string' &&
        (data.role === 'user' || data.role === 'assistant') &&
        typeof data.text === 'string' &&
        data.text.length <= 1000 &&
        (data.source === undefined || typeof data.source === 'string') &&
        (data.model === undefined || typeof data.model === 'string') &&
        (data.filter === undefined ||
          (object(data.filter) &&
            date(data.filter.start) &&
            date(data.filter.end) &&
            data.filter.start < data.filter.end &&
            (data.filter.category === undefined || categories.includes(data.filter.category as never)) &&
            (data.filter.metric === undefined ||
              ['income', 'expense', 'net'].includes(data.filter.metric as string))))
      )
    case 'link':
      return (
        uuid.test(row.id) &&
        typeof data.messageId === 'string' &&
        typeof data.transactionId === 'string' &&
        typeof data.revision === 'number' &&
        Number.isSafeInteger(data.revision) &&
        data.revision >= 0 &&
        (data.position === undefined ||
          (Number.isSafeInteger(data.position) && Number(data.position) >= 0))
      )
    default:
      return false
  }
}

export function makeTransfer(rows: Row[]) {
  const active = new Set(rows.filter((row) => !row.deletedAt).map((row) => row.id))
  return {
    format,
    version: 1,
    exportedAt: new Date().toISOString(),
    rows: rows.filter(
      (row) =>
        !row.deletedAt &&
        (row.entity !== 'link' ||
          (active.has(row.data.transactionId) && active.has(row.data.messageId))),
    ),
  }
}

export function readTransfer(value: unknown): Row[] {
  const invalid = () =>
    new Error('ไฟล์นี้ไม่ใช่ไฟล์ย้ายข้อมูล My Financial ที่รองรับ หรือข้อมูลในไฟล์ไม่ครบ')
  if (
    !object(value) ||
    value.format !== format ||
    value.version !== 1 ||
    !Array.isArray(value.rows) ||
    !value.rows.every(canTransfer)
  )
    throw invalid()
  const rows = value.rows as Row[]
  const byId = new Map(rows.map((row) => [row.id, row]))
  if (
    byId.size !== rows.length ||
    rows.some(
      (row) =>
        (row.entity === 'message' && byId.get(row.data.roomId)?.entity !== 'room') ||
        (row.entity === 'link' &&
          (byId.get(row.data.messageId)?.entity !== 'message' ||
            byId.get(row.data.transactionId)?.entity !== 'transaction')),
    )
  )
    throw invalid()
  return [...rows].sort((a, b) => order[a.entity] - order[b.entity])
}
