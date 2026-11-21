import {
  categories,
  methods,
  money,
  settle,
  thaiDigits,
  validDate,
  validItem,
  type DraftItem,
  type Intent,
  type TransactionInput,
} from './domain'
import type { Transaction } from './repository'

type Progress = (message: string) => void
type Analysis = { intent: Intent; ai?: { model: string; interpretation: unknown }; notice?: string }
export interface TextInterpreter {
  run(text: string, today: string, progress: Progress): Promise<unknown>
}
export interface SlipReader {
  run(image: Blob, progress: Progress): Promise<string>
}

const model = import.meta.env.VITE_QWEN_MODEL || 'onnx-community/Qwen3-1.7B-ONNX'
const monthNames = ['มค', 'กพ', 'มีค', 'เมย', 'พค', 'มิย', 'กค', 'สค', 'กย', 'ตค', 'พย', 'ธค']
const normalized = (value?: string) =>
  value
    ?.normalize('NFKC')
    .replace(/[\s-]+/g, '')
    .toLowerCase() || ''
export function findDuplicates(input: Partial<TransactionInput>, entries: Transaction[]) {
  const reference = normalized(input.slip?.reference)
  const party = normalized(input.slip?.party)
  const time = input.slip?.time
  return entries.filter(
    ({ data }) =>
      (Boolean(reference) && normalized(data.slip?.reference) === reference) ||
      (Boolean(input.amount && input.date && time && party) &&
        data.amount === input.amount &&
        data.date === input.date &&
        data.slip?.time === time &&
        normalized(data.slip?.party) === party),
  )
}
export function extractSlip(text: string, today: string): Partial<TransactionInput> {
  const value = thaiDigits(text)
  const amounts = new Set<number>()
  const lines = value.split('\n')
  for (const [index, line] of lines.entries()) {
    const amount =
      line.match(
        /(?:ยอดโอน|ยอดเงิน|จำนวนเงิน|จำนวน|amount)\s*[:：]?\s*(?:฿|THB)?\s*([\d,.]+)\s*(?:บาท|THB)?/i,
      )?.[1] ??
      (/(?:ยอดโอน|ยอดเงิน|จำนวนเงิน|amount)\s*[:：]?\s*$/i.test(line)
        ? lines[index + 1]?.match(/^\s*(?:฿|THB)?\s*([\d,.]+)/i)?.[1]
        : undefined)
    const cents = money(amount ?? '')
    if (cents && cents > 0) amounts.add(cents)
  }
  const reference = value.match(
    /(?:เลขที่รายการ|เลขอ้างอิง|รหัสอ้างอิง|reference|transaction id)\s*[:：]?\s*([A-Z0-9-]{6,80})/i,
  )?.[1]
  const time = value.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/)
  const party = value
    .match(/(?:ผู้รับ(?:เงิน)?|ไปยัง|โอนให้|recipient)\s*[:：]?\s*([^\r\n]{2,100})/i)?.[1]
    ?.trim()
  const dateMatch = value.match(/\b(\d{1,2})[ /-]+(\d{1,2}|[ก-ฮ]+(?:\.[ก-ฮ]+)*\.?)[ /-]+(\d{4}|\d{2})\b/)
  let date = value.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0]
  if (!date && dateMatch) {
    const [, day, month, year] = dateMatch
    const monthIndex = Number(month) || monthNames.indexOf(month.replace(/\./g, '')) + 1
    const yearNumber = Number(year)
    const fullYear =
      yearNumber >= 2400 ? yearNumber - 543 : year.length === 2 ? 2500 + yearNumber - 543 : yearNumber
    date = `${fullYear}-${String(monthIndex).padStart(2, '0')}-${day.padStart(2, '0')}`
  }
  return {
    amount: amounts.size === 1 ? [...amounts][0] : undefined,
    date: date && validDate(date) ? date : today,
    slip: { reference, time: time ? time[1].padStart(2, '0') + ':' + time[2] : undefined, party },
  }
}

let worker: Worker | undefined
const qwen: TextInterpreter = {
  run(text, today, progress) {
    worker ??= new Worker(new URL('./qwen.worker.ts', import.meta.url), { type: 'module' })
    return new Promise((resolve, reject) => {
      const active = worker!
      const timer = window.setTimeout(() => finish(new Error('หมดเวลารอโมเดล')), 180000)
      const close = () => {
        clearTimeout(timer)
        active.removeEventListener('message', onMessage)
        active.removeEventListener('error', onError)
      }
      function finish(error: Error) {
        close()
        active.terminate()
        worker = undefined
        reject(error)
      }
      function onError() {
        finish(new Error('เปิดโมเดลไม่ได้'))
      }
      function onMessage(event: MessageEvent) {
        if (event.data.progress) progress(event.data.progress)
        else if (event.data.error) finish(new Error(event.data.error))
        else {
          close()
          resolve(event.data.result)
        }
      }
      active.addEventListener('message', onMessage)
      active.addEventListener('error', onError)
      active.postMessage({ text, today, model, categories, methods })
    })
  },
}
const ocr: SlipReader = {
  async run(image, progress) {
    const runtime =
      import.meta.env.VITE_OCR_RUNTIME ||
      'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.esm.min.js'
    const { createWorker } = await import(/* @vite-ignore */ runtime)
    const engine = await createWorker('tha+eng', 1, {
      workerPath:
        import.meta.env.VITE_OCR_WORKER ||
        'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js',
      corePath: import.meta.env.VITE_OCR_CORE || 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0',
      langPath: import.meta.env.VITE_OCR_LANGUAGE || undefined,
      logger: (status: { status: string; progress: number }) =>
        progress(
          status.status === 'recognizing text'
            ? 'กำลังอ่านสลิป ' + Math.round(status.progress * 100) + '%'
            : 'กำลังเตรียม OCR…',
        ),
    })
    try {
      return (await engine.recognize(image)).data.text
    } finally {
      await engine.terminate()
    }
  },
}
export async function readSlip(image: Blob, today: string, progress: Progress, reader = ocr) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const text = await Promise.race([
      reader.run(image, progress),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('หมดเวลารอ OCR')), 60000)
      }),
    ])
    const fields = extractSlip(text, today)
    if (fields.amount === undefined) {
      const { amount: _, ...rest } = fields
      return { fields: rest, notice: 'อ่านยอดจากสลิปได้ไม่ชัด กรุณาระบุยอดและตรวจวันที่' }
    }
    return { fields }
  } catch {
    return { fields: { slip: {} }, notice: 'อ่านสลิปไม่ได้ กรุณากรอกข้อมูลจากรูป' }
  } finally {
    clearTimeout(timer)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
export function validateModel(
  raw: unknown,
  source: string,
  today: string,
  local: Intent,
): Intent | undefined {
  if (!isObject(raw)) return
  if (
    raw.kind === 'budget' &&
    local.kind === 'budget' &&
    raw.month === local.month &&
    raw.amount === local.amount
  )
    return local
  if (
    raw.kind === 'query' &&
    local.kind === 'query' &&
    raw.range === local.range &&
    raw.metric === local.metric &&
    (raw.category ?? undefined) === local.category &&
    (raw.offset ?? 0) === local.offset
  )
    return local
  if (raw.kind !== 'record' && raw.kind !== 'clarify') return
  if (!Array.isArray(raw.items) || !raw.items.length || raw.items.length > 12) return
  if (local.kind !== 'record' && local.kind !== 'clarify') return
  if (raw.items.length !== local.items.length || local.kind !== raw.kind) return
  const items: DraftItem[] = []
  for (const [index, item] of raw.items.entries()) {
    const expected = local.items[index]
    if (
      !isObject(item) ||
      typeof item.name !== 'string' ||
      item.amount !== expected.amount ||
      item.date !== expected.date ||
      item.type !== expected.type ||
      item.counted !== expected.counted
    )
      return
    const name = item.name.trim()
    const safeName = name && source.includes(name) ? name : expected.name
    const candidate = {
      ...expected,
      name: safeName,
      category:
        expected.category === 'ไม่ระบุหมวด' && categories.includes(item.category as never)
          ? (item.category as TransactionInput['category'])
          : expected.category,
    }
    if (
      candidate.type !== null &&
      candidate.amount !== null &&
      candidate.counted !== null &&
      !validItem(candidate as TransactionInput)
    )
      return
    items.push(candidate)
  }
  const validated = settle(items)
  if (validated.kind === raw.kind && (today === local.items[0].date || validDate(local.items[0].date)))
    return validated
}
export async function analyzeText(
  text: string,
  today: string,
  local: Intent,
  progress: Progress,
  interpreter = qwen,
): Promise<Analysis> {
  if (import.meta.env.VITE_ENABLE_QWEN === 'false' || !('gpu' in navigator)) return { intent: local }
  try {
    const raw = await interpreter.run(text, today, progress)
    const intent = validateModel(raw, text, today, local)
    if (!intent) return { intent: local }
    return { intent, ai: { model, interpretation: raw } }
  } catch {
    return { intent: local, notice: 'เปิด Qwen ไม่สำเร็จ ใช้ตัวอ่านพื้นฐานหรือกรอกเองได้' }
  }
}
