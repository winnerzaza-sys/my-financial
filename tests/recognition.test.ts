import { expect, it } from 'vitest'
import { extractSlip, findDuplicates, validateModel } from '../src/recognition'
import { makeRow } from '../src/repository'
import { interpret } from '../src/domain'

it('leaves ambiguous OCR amounts blank and uses reference or a full composite for duplicates', () => {
  const date = '2026-11-22'
  expect(extractSlip('จำนวนเงิน 50.00 บาท\nจำนวนเงิน 70.00 บาท', date).amount).toBeUndefined()
  const item = makeRow('transaction', {
    name: 'กาแฟ',
    amount: 5000,
    date,
    type: 'expense',
    method: 'โอน',
    category: 'อาหารและเครื่องดื่ม',
    counted: true,
    slip: { reference: 'AB0123456', time: '09:30', party: 'ร้านกาแฟ' },
  })
  expect(findDuplicates({ amount: 5000, date }, [item])).toHaveLength(0)
  expect(
    findDuplicates({ amount: 5000, date, slip: { time: '09:30', party: 'ร้านกาแฟ' } }, [item]),
  ).toHaveLength(1)
  expect(findDuplicates({ slip: { reference: 'ab0123456' } }, [item])).toHaveLength(1)
  expect(
    extractSlip('22 พ.ย. 2569 09:30\nไปยัง ร้านกาแฟ\nยอดโอน 50.00 บาท\nเลขอ้างอิง AB0123456', date),
  ).toMatchObject({
    date,
    amount: 5000,
    slip: { reference: 'AB0123456', time: '09:30', party: 'ร้านกาแฟ' },
  })
})

it('rejects an invented amount, missing transaction, or changed direction', () => {
  const text = 'เพื่อนโอนมาให้ 100 บาท และซื้อขนม 50'
  const date = '2026-11-22'
  const intent = interpret(text, date)
  if (intent.kind !== 'record') throw Error(intent.kind)
  expect(validateModel(intent, text, date, intent)).toEqual(intent)
  expect(
    validateModel(
      { ...intent, items: [{ ...intent.items[0], amount: 99900 }, intent.items[1]] },
      text,
      date,
      intent,
    ),
  ).toBeUndefined()
  expect(validateModel({ ...intent, items: [intent.items[0]] }, text, date, intent)).toBeUndefined()
  expect(
    validateModel(
      { ...intent, items: [{ ...intent.items[0], type: 'expense' }, intent.items[1]] },
      text,
      date,
      intent,
    ),
  ).toBeUndefined()
})
