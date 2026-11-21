import { describe, expect, it } from 'vitest'
import { interpret, period, summarize, thaiToday } from '../src/domain'

describe('ธุรกรรมภาษาไทย', () => {
  it('แยกเงินคืนกับรายจ่าย และรวมสุทธิจากรายการล่าสุด', () => {
    const result = interpret('วันนี้เพื่อนโอนค่าข้าวมาให้ 100 บาท และซื้อขนมไป 50 บาท', '2026-11-22')
    if (result.kind !== 'record') throw Error(result.kind)
    expect(result.items.map((item) => item.type)).toEqual(['refund', 'expense'])
    expect(summarize(result.items).net).toBe(5000)
    expect(summarize([result.items[0], { ...result.items[1], amount: 6000 }]).net).toBe(4000)
  })
  it('พักทั้งชุดเมื่อยอดขาด แล้วใช้คำตอบเติมยอด', () => {
    const draft = interpret('ซื้อขนม และซื้อกาแฟ 70', '2026-11-22')
    if (draft.kind !== 'clarify') throw Error(draft.kind)
    const done = interpret('๓๕', '2026-11-23', draft.items)
    if (done.kind !== 'record') throw Error(done.kind)
    expect(done.items.map((item) => [item.amount, item.date])).toEqual([
      [3500, '2026-11-22'],
      [7000, '2026-11-22'],
    ])
  })
  it('คำนวณจำนวนและราคาต่อหน่วย', () => {
    const result = interpret('เมื่อวานซื้อกาแฟสองแก้ว แก้วละ ๗๐', '2026-11-22')
    expect(result).toMatchObject({
      kind: 'record',
      items: [{ amount: 14000, quantity: 2, unit: 'แก้ว', date: '2026-11-21' }],
    })
  })
  it('ยอดชำระบัตรและยอดจากแอปที่นับแล้วมีประวัติแต่ไม่เพิ่มยอด', () => {
    const result = interpret(
      'เติม Starbucks 200 และจ่ายจากยอดเติมที่นับแล้ว 50 และจ่ายบัตร ttb ลงยอดซื้อแล้ว 300',
      '2026-11-22',
    )
    if (result.kind !== 'record') throw Error(result.kind)
    expect(result.items.map((item) => item.counted)).toEqual([true, false, false])
    expect(summarize(result.items).expense).toBe(20000)
  })
  it('ตัดวันตามกรุงเทพและสัปดาห์เริ่มจันทร์', () => {
    expect(thaiToday(new Date('2026-11-01T17:00:00Z'))).toBe('2026-11-02')
    expect(period('2026-11-01', 'week')).toEqual({ start: '2026-10-26', end: '2026-11-02' })
    expect(period('2026-12-01', 'month', -1)).toEqual({ start: '2026-11-01', end: '2026-12-01' })
  })
})

it('asks which way an ambiguous transfer went and whether a reload was counted', () => {
  const result = interpret('โอน 500 และจ่ายจากยอดเติม 70', '2026-11-22')
  if (result.kind !== 'clarify') throw Error(result.kind)
  const direction = interpret('โอนระหว่างบัญชีตัวเอง', '2026-11-22', result.items)
  if (direction.kind !== 'clarify') throw Error(direction.kind)
  expect(interpret('ลงแล้ว', '2026-11-22', direction.items)).toMatchObject({
    kind: 'record',
    items: [
      { type: 'transfer', counted: false, amount: 50000 },
      { type: 'wallet_spend', counted: false, amount: 7000 },
    ],
  })
})

it('reads Thai money in words and accepts a standalone quantity and unit-price phrase', () => {
  expect(interpret('ซื้อขนมห้าสิบเอ็ดบาท', '2026-11-22')).toMatchObject({
    kind: 'record',
    items: [{ amount: 5100 }],
  })
  expect(interpret('สองแก้ว แก้วละ 70', '2026-11-22')).toMatchObject({
    kind: 'record',
    items: [{ amount: 14000, quantity: 2 }],
  })
})
