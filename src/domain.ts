export const categories = [
  'อาหารและเครื่องดื่ม',
  'กีฬา › แบดมินตัน',
  'เติมเงินเข้าแอป › เซเว่น',
  'เติมเงินเข้าแอป › ทางด่วน',
  'เติมเงินเข้าแอป › Starbucks',
  'เติมเงินเข้าแอป › แอปอื่น ๆ',
  'จ่ายบัตรเครดิต › ttb',
  'จ่ายบัตรเครดิต › KBank',
  'จ่ายบัตรเครดิต › กรุงศรี',
  'จ่ายบัตรเครดิต › อื่น ๆ',
  'เติมน้ำมัน',
  'หาหมอ',
  'อื่น ๆ',
  'ไม่ระบุหมวด',
] as const
export const methods = [
  'ไม่ระบุ',
  'เงินสด',
  'โอน',
  'บัตร ttb',
  'บัตร KBank',
  'บัตรกรุงศรี',
  'บัตรเครดิต',
  'ยอดเติมในแอป',
] as const
export const types = [
  'expense',
  'income',
  'refund',
  'transfer',
  'card_payment',
  'top_up',
  'wallet_spend',
] as const
export type Kind = (typeof types)[number]
export type Range = 'day' | 'week' | 'month'
export interface TransactionInput {
  name: string
  amount: number
  type: Kind
  category: (typeof categories)[number]
  method: (typeof methods)[number]
  counted: boolean
  date: string
  quantity?: number
  unit?: string
  slip?: { reference?: string; time?: string; party?: string }
}
export type DraftItem = Omit<TransactionInput, 'amount' | 'counted' | 'type'> & {
  amount: number | null
  counted: boolean | null
  type: Kind | null
}
export type Intent =
  | { kind: 'record'; items: TransactionInput[] }
  | { kind: 'clarify'; items: DraftItem[]; question: string }
  | {
      kind: 'query'
      range: Range
      offset: number
      category?: TransactionInput['category']
      metric: 'expense' | 'income' | 'net'
    }
  | { kind: 'budget'; amount: number; month: string }
  | { kind: 'unknown' }

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Bangkok',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
export const thaiToday = (now = new Date()) => dateFormatter.format(now)
const iso = (date: Date) => date.toISOString().slice(0, 10)
export function shiftDate(value: string, days: number) {
  const date = new Date(value + 'T00:00:00Z')
  date.setUTCDate(date.getUTCDate() + days)
  return iso(date)
}
export function period(value: string, range: Range, offset = 0) {
  if (range === 'day') return { start: shiftDate(value, offset), end: shiftDate(value, offset + 1) }
  const date = new Date(value + 'T00:00:00Z')
  if (range === 'week') {
    const monday = (date.getUTCDay() + 6) % 7
    const start = shiftDate(value, offset * 7 - monday)
    return { start, end: shiftDate(start, 7) }
  }
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + offset)
  const start = iso(date)
  date.setUTCMonth(date.getUTCMonth() + 1)
  return { start, end: iso(date) }
}
export const inPeriod = (date: string, bounds: ReturnType<typeof period>) =>
  date >= bounds.start && date < bounds.end
export const incoming = (type: Kind) => type === 'income' || type === 'refund'
export function summarize(items: TransactionInput[]) {
  let income = 0
  let expense = 0
  let refunds = 0
  const byCategory = new Map<TransactionInput['category'], number>()
  for (const item of items) {
    if (!item.counted || item.type === 'transfer') continue
    if (incoming(item.type)) {
      income += item.amount
      if (item.type === 'refund') refunds += item.amount
    } else {
      expense += item.amount
      byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + item.amount)
    }
  }
  return { income, expense, refunds, net: income - expense, byCategory }
}
export const thaiDigits = (value: string) =>
  value.replace(/[๐-๙]/g, (x) => String(x.charCodeAt(0) - 3664))
const spokenDigits: Record<string, number> = {
  ศูนย์: 0,
  หนึ่ง: 1,
  เอ็ด: 1,
  สอง: 2,
  ยี่: 2,
  สาม: 3,
  สี่: 4,
  ห้า: 5,
  หก: 6,
  เจ็ด: 7,
  แปด: 8,
  เก้า: 9,
}
const spokenPlaces: Record<string, number> = { สิบ: 10, ร้อย: 100, พัน: 1000, หมื่น: 10000, แสน: 100000 }
const wordPattern = Object.keys({ ...spokenDigits, ...spokenPlaces, ล้าน: 1 }).join('|')
function spokenNumber(value: string): number | null {
  const tokens = value.match(new RegExp(wordPattern, 'g')) ?? []
  if (!value || tokens.join('') !== value) return null
  let total = 0
  let section = 0
  let digit: number | undefined
  let lastPlace = 1000000
  for (const token of tokens) {
    if (token === 'ล้าน') {
      total = (total + section + (digit ?? 0)) * 1000000
      section = 0
      digit = undefined
      lastPlace = 1000000
    } else if (token in spokenPlaces) {
      const place = spokenPlaces[token]
      if (place >= lastPlace) return null
      section += (digit ?? 1) * place
      digit = undefined
      lastPlace = place
    } else {
      if (digit !== undefined) return null
      digit = spokenDigits[token]
    }
  }
  return total + section + (digit ?? 0)
}

export function money(value: string | number) {
  const matched = /^(\d+)(?:\.(\d{1,2}))?$/.exec(thaiDigits(String(value)).replace(/,/g, '').trim())
  const words = !matched ? spokenNumber(String(value).replace(/\s/g, '')) : null
  if (!matched && words === null) return null
  const cents = matched
    ? Number(matched[1]) * 100 + Number((matched[2] ?? '').padEnd(2, '0'))
    : words! * 100
  return Number.isSafeInteger(cents) ? cents : null
}
export function validDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    iso(new Date(value)) === value
  )
}
export function validItem(x: TransactionInput) {
  return (
    !!x.name.trim() &&
    x.name.length <= 160 &&
    Number.isSafeInteger(x.amount) &&
    x.amount > 0 &&
    validDate(x.date) &&
    types.includes(x.type) &&
    typeof x.counted === 'boolean' &&
    categories.includes(x.category) &&
    methods.includes(x.method) &&
    (x.quantity === undefined || (Number.isFinite(x.quantity) && x.quantity > 0)) &&
    (x.type !== 'transfer' || !x.counted)
  )
}
export function classify(value: string): TransactionInput['category'] {
  if (/^(?:วันนี้\s*|เมื่อวาน\s*)?(?:จ่าย|ชำระ)(?:ยอด|ค่า|ค่าชำระ)?\s*บัตร/.test(value)) {
    if (/ttb/i.test(value)) return 'จ่ายบัตรเครดิต › ttb'
    if (/kbank|กสิกร/i.test(value)) return 'จ่ายบัตรเครดิต › KBank'
    if (/กรุงศรี|uchoo/i.test(value)) return 'จ่ายบัตรเครดิต › กรุงศรี'
    return 'จ่ายบัตรเครดิต › อื่น ๆ'
  }
  if (/น้ำมัน|บางจาก|ปั๊ม/.test(value)) return 'เติมน้ำมัน'
  if (/แบด/.test(value)) return 'กีฬา › แบดมินตัน'
  if (/หมอ|โรงพยาบาล/.test(value)) return 'หาหมอ'
  if (/เติม/.test(value)) {
    if (/เซเว่น|7-eleven/i.test(value)) return 'เติมเงินเข้าแอป › เซเว่น'
    if (/ทางด่วน|easy.?pass/i.test(value)) return 'เติมเงินเข้าแอป › ทางด่วน'
    if (/starbucks|สตาร์บัค/i.test(value)) return 'เติมเงินเข้าแอป › Starbucks'
    if (/แอป|วอลเล็ต/.test(value)) return 'เติมเงินเข้าแอป › แอปอื่น ๆ'
  }
  if (/กาแฟ|ข้าว|ขนม|อาหาร|ชา|น้ำดื่ม/.test(value)) return 'อาหารและเครื่องดื่ม'
  return 'ไม่ระบุหมวด'
}
const amountPattern = '[0-9]+(?:,[0-9]{3})*(?:\\.[0-9]{1,2})?'
const currencyPattern = `(?:${amountPattern}|(?:${wordPattern})+)`
const numberWords = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า', 'สิบ']
const unitPattern = 'แก้ว|จาน|กล่อง|ขวด|ชิ้น|ถุง|ชุด|ใบ|อัน|แพ็ก'
const bundledAmount = new RegExp(
  `(\\d+|${numberWords.join('|')})\\s*(${unitPattern})[ ,]*\\2ละ\\s*(${currencyPattern})`,
)
function lineToItem(line: string, date: string): DraftItem {
  const category = classify(line)
  const type: Kind | null = /โอน.*(บัญชีตัวเอง|บัญชีตัวเรา|ระหว่างบัญชี)/.test(line)
    ? 'transfer'
    : /เพื่อน.*(โอน|คืน)|คืนเงิน|ได้เงินคืน|โอน.*มาให้/.test(line)
      ? 'refund'
      : /เงินเดือน|รายได้|ได้รับเงิน|รายรับ|โบนัส|ยอดขาย/.test(line)
        ? 'income'
        : category.startsWith('จ่ายบัตรเครดิต')
          ? 'card_payment'
          : /จ่ายจากยอดเติม|ใช้ยอดเติม|จ่ายด้วยยอดเติม/.test(line)
            ? 'wallet_spend'
            : category.startsWith('เติมเงินเข้าแอป')
              ? 'top_up'
              : /โอน/.test(line) && !/โอนให้|โอนไป|จ่าย|ซื้อ/.test(line)
                ? null
                : 'expense'
  const bundle = bundledAmount.exec(line)
  const quantity = bundle
    ? /^\d+$/.test(bundle[1])
      ? Number(bundle[1])
      : numberWords.indexOf(bundle[1])
    : undefined
  const unitPrice = bundle ? money(bundle[3]) : null
  const match = new RegExp(
    `(${currencyPattern})\\s*(?:บาท|฿)|(?:^|[^0-9,.])(${amountPattern})(?=\\s*$|\\s+(?:เงินสด|บัตร|โอน))`,
  ).exec(line)
  const amount =
    quantity && unitPrice ? quantity * unitPrice : match ? money(match[1] ?? match[2]) : null
  const counted =
    type === 'transfer'
      ? false
      : type === 'card_payment'
        ? /ยังไม่(ได้)?(ลง|บันทึก)/.test(line)
          ? true
          : /(ลง|บันทึก)ยอดซื้อแล้ว|นับแล้ว/.test(line)
            ? false
            : null
        : type === 'wallet_spend'
          ? /ยังไม่(ได้)?(ลง|นับ)/.test(line)
            ? true
            : /นับแล้ว|ลงยอดเติมแล้ว/.test(line)
              ? false
              : null
          : true
  const method = /เงินสด/.test(line)
    ? 'เงินสด'
    : /บัตร.*ttb/i.test(line)
      ? 'บัตร ttb'
      : /บัตร.*(กสิกร|kbank)/i.test(line)
        ? 'บัตร KBank'
        : /บัตร.*กรุงศรี/.test(line)
          ? 'บัตรกรุงศรี'
          : /โอน/.test(line)
            ? 'โอน'
            : type === 'wallet_spend'
              ? 'ยอดเติมในแอป'
              : /บัตร/.test(line)
                ? 'บัตรเครดิต'
                : 'ไม่ระบุ'
  const name = (bundle ? line.replace(bundle[0], '') : match ? line.replace(match[0], '') : line)
    .replace(/^(วันนี้|เมื่อวาน)\s*/, '')
    .trim()
  return {
    name: name || 'รายการจากแชท',
    amount: amount && Number.isSafeInteger(amount) ? amount : null,
    type,
    category,
    method,
    counted,
    date,
    quantity,
    unit: bundle?.[2],
  }
}
export function settle(items: DraftItem[]): Intent {
  const missing = items.find(
    (item) => item.type === null || item.amount === null || item.counted === null,
  )
  if (missing)
    return {
      kind: 'clarify',
      items,
      question:
        missing.type === null
          ? `“${missing.name}” เป็นเงินเข้า เงินออก หรือโอนระหว่างบัญชีตัวเอง?`
          : missing.amount === null
            ? `“${missing.name}” กี่บาท?`
            : `“${missing.name}” เคยบันทึกยอด${missing.type === 'wallet_spend' ? 'เติม' : 'ซื้อ'}แล้วไหม? ตอบ “ลงแล้ว” หรือ “ยังไม่ได้ลง”`,
    }
  const complete = items as TransactionInput[]
  return complete.length && complete.every(validItem)
    ? { kind: 'record', items: complete }
    : { kind: 'unknown' }
}
export function interpret(text: string, today: string, draft?: DraftItem[]): Intent {
  const value = thaiDigits(text.trim())
  if (draft?.length) {
    const idx = draft.findIndex(
      (item) => item.type === null || item.amount === null || item.counted === null,
    )
    if (idx >= 0) {
      const item = draft[idx]
      const amount = money(value.replace(/\s*บาท$/, ''))
      const fixed = { ...item }
      if (item.type === null) {
        if (/เงินเข้า|รับเงิน|มีคนโอนมา/.test(value)) fixed.type = 'income'
        else if (/เงินออก|โอนให้|โอนไป/.test(value)) fixed.type = 'expense'
        else if (/ตัวเอง|ระหว่างบัญชี/.test(value)) {
          fixed.type = 'transfer'
          fixed.counted = false
        } else if (/เงินคืน|เพื่อนคืน/.test(value)) fixed.type = 'refund'
        if (fixed.type && item.amount === null) fixed.amount = lineToItem(value, item.date).amount
      } else if (item.amount === null && amount && amount > 0) fixed.amount = amount
      else if (item.amount !== null && /^(ยัง|ยังไม่ได้ลง|ไม่ได้ลง|ยังไม่ลง)/.test(value))
        fixed.counted = true
      else if (item.amount !== null && /^(ลงแล้ว|บันทึกแล้ว|ใช่|นับแล้ว)/.test(value))
        fixed.counted = false
      return settle(draft.map((entry, index) => (index === idx ? fixed : entry)))
    }
  }
  if (/ตั้งงบ|แก้งบ/.test(value)) {
    const amount = money(value.match(new RegExp(currencyPattern))?.[0] ?? '')
    if (amount !== null)
      return {
        kind: 'budget',
        amount,
        month: period(
          today,
          'month',
          /เดือนหน้า/.test(value) ? 1 : /เดือนที่แล้ว|เดือนก่อน/.test(value) ? -1 : 0,
        ).start,
      }
    return { kind: 'unknown' }
  }
  if (/เท่าไหร่|เท่าไร|กี่บาท|ขอดูยอด|สรุปยอด|ใช้ไปเท่า/.test(value)) {
    const category = classify(value)
    return {
      kind: 'query',
      range: /สัปดาห์|อาทิตย์/.test(value) ? 'week' : /เดือน/.test(value) ? 'month' : 'day',
      offset: /เมื่อวาน|ที่แล้ว|ก่อน/.test(value) ? -1 : 0,
      category: category === 'ไม่ระบุหมวด' ? undefined : category,
      metric: /สุทธิ/.test(value) ? 'net' : /เงินเข้า|รายรับ|รายได้/.test(value) ? 'income' : 'expense',
    }
  }
  if (
    !bundledAmount.test(value) &&
    !/ซื้อ|จ่าย|ชำระ|เติม|โอน|ได้เงิน|ได้รับ|ค่[a-zก-๙]|กิน|เงินเดือน|รายได้|รายรับ|คืนเงิน|โบนัส|ยอดขาย|ใช้ยอด|รูด/.test(
      value,
    )
  )
    return { kind: 'unknown' }
  const defaultDate = /^เมื่อวาน/.test(value) ? shiftDate(today, -1) : today
  return settle(
    value
      .split(/\s*(?:และ|\n|;|แล้วก็|กับ(?=\s*(?:ซื้อ|จ่าย|เติม|โอน|ได้รับ)))\s*/)
      .filter(Boolean)
      .map((line) =>
        lineToItem(
          line,
          /เมื่อวาน/.test(line) ? shiftDate(today, -1) : /วันนี้/.test(line) ? today : defaultDate,
        ),
      ),
  )
}
export const baht = (cents: number) =>
  new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 }).format(cents / 100)
