import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Drawer,
  Form,
  Input,
  InputNumber,
  List,
  Select,
  Space,
  Switch,
} from 'antd'
import dayjs from 'dayjs'
import { useId, useState } from 'react'
import {
  baht,
  categories,
  incoming,
  methods,
  money,
  types,
  validItem,
  type Kind,
  type TransactionInput,
} from './domain'
import type { Transaction } from './repository'

export const kindLabel: Record<Kind, string> = {
  expense: 'รายจ่าย',
  income: 'รายได้',
  refund: 'เงินคืน',
  transfer: 'โอนระหว่างบัญชี',
  card_payment: 'ชำระบัตรเครดิต',
  top_up: 'เติมเงินเข้าแอป',
  wallet_spend: 'จ่ายจากยอดเติม',
}
export function baseItem(date: string): TransactionInput {
  return {
    name: '',
    amount: 0,
    date,
    type: 'expense',
    category: 'ไม่ระบุหมวด',
    method: 'ไม่ระบุ',
    counted: true,
  }
}
export function signed(item: TransactionInput) {
  return (item.type === 'transfer' ? '' : incoming(item.type) ? '+' : '−') + '฿' + baht(item.amount)
}
interface Fields {
  name: string
  amount: string
  date: dayjs.Dayjs
  type: Kind
  category: TransactionInput['category']
  method: TransactionInput['method']
  counted: boolean
  quantity?: number
  unit?: string
  flagged?: boolean
  reference?: string
  time?: string
  party?: string
}
const options = <T extends string>(values: readonly T[]) =>
  values.map((value) => ({ value, label: value }))
export function TransactionForm({
  initial,
  original,
  imageUrl,
  onClose,
  onSave,
  onRemove,
  getDuplicates,
}: {
  initial: TransactionInput
  original?: Transaction
  imageUrl?: string
  onClose: () => void
  onSave: (input: TransactionInput, flagged: boolean) => Promise<void>
  onRemove?: () => void
  getDuplicates?: (input: Partial<TransactionInput>) => Transaction[]
}) {
  const formId = useId()
  const [form] = Form.useForm<Fields>()
  const type = Form.useWatch('type', form) ?? initial.type
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const slip = Boolean(imageUrl || initial.slip)
  const [duplicates, setDuplicates] = useState<Transaction[]>(() => getDuplicates?.(initial) ?? [])
  function updateDuplicates() {
    if (!getDuplicates) return
    setConfirmed(false)
    const values = form.getFieldsValue()
    setDuplicates(
      getDuplicates({
        amount: money(values.amount ?? '') ?? undefined,
        date: values.date?.format('YYYY-MM-DD'),
        slip: { reference: values.reference, time: values.time, party: values.party },
      }),
    )
  }
  function formInitial() {
    return {
      ...initial,
      amount: initial.amount ? (initial.amount / 100).toFixed(2).replace(/\.00$/, '') : '',
      date: dayjs(initial.date),
      ...initial.slip,
      type: slip && !original ? undefined : initial.type,
    }
  }
  async function save(values: Fields) {
    const {
      name,
      amount,
      date,
      type,
      category,
      method,
      counted,
      quantity,
      unit,
      reference,
      time,
      party,
    } = values
    const input: TransactionInput = {
      name: name.trim(),
      amount: money(amount) ?? 0,
      date: date.format('YYYY-MM-DD'),
      type,
      category,
      method,
      counted: type === 'transfer' ? false : counted,
      quantity: quantity ?? undefined,
      unit: unit?.trim() || undefined,
      slip: slip
        ? {
            reference: reference?.trim() || undefined,
            time: time || undefined,
            party: party?.trim() || undefined,
          }
        : undefined,
    }
    if (!validItem(input)) {
      setError('ตรวจชื่อรายการ วันที่ และยอดเงินก่อนบันทึก')
      return
    }
    const matches = getDuplicates?.(input) ?? []
    if (
      matches.length &&
      (!confirmed || matches.some((row) => !duplicates.some((item) => item.id === row.id)))
    ) {
      setDuplicates(matches)
      setConfirmed(false)
      setError('ตรวจรายการที่คล้ายกันและยืนยันด้านล่าง')
      return
    }
    setBusy(true)
    try {
      await onSave(input, Boolean(values.flagged))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Drawer
      open
      placement="bottom"
      height="min(88dvh, 900px)"
      onClose={onClose}
      title={original ? 'แก้ไขรายการ' : slip ? 'ตรวจสลิปก่อนบันทึก' : 'กรอกรายการเอง'}
      footer={
        <div className="drawer-body form-actions">
          <Space wrap>
            <Button type="primary" htmlType="submit" form={formId} loading={busy}>
              บันทึก
            </Button>
            <Button onClick={onClose}>ยกเลิก</Button>
            {onRemove && (
              <Button danger disabled={busy} onClick={onRemove}>
                ลบรายการ
              </Button>
            )}
          </Space>
        </div>
      }
    >
      <Form
        id={formId}
        form={form}
        initialValues={formInitial()}
        layout="vertical"
        className="drawer-body"
        onValuesChange={updateDuplicates}
        onFinish={(values) => void save(values)}
      >
        {imageUrl && <img className="slip-image" src={imageUrl} alt="รูปสลิปที่แนบ" />}
        {duplicates.length > 0 && (
          <Alert
            type="warning"
            showIcon
            message="อาจซ้ำกับรายการเดิม"
            description={
              <>
                <List
                  dataSource={duplicates}
                  renderItem={(entry) => (
                    <List.Item>
                      {entry.data.date} {entry.data.slip?.time} · {entry.data.name} ·{' '}
                      {signed(entry.data)}
                    </List.Item>
                  )}
                />
                <Checkbox checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)}>
                  ตรวจแล้วและต้องการบันทึก
                </Checkbox>
              </>
            }
          />
        )}
        {error && <Alert type="error" message={error} showIcon />}
        <Form.Item
          name="type"
          label="ทิศทางเงินและชนิดรายการ"
          rules={[{ required: true, message: 'เลือกทิศทางเงิน' }]}
        >
          <Select
            placeholder="เลือกทิศทางเงิน"
            options={types.map((value) => ({ value, label: kindLabel[value] }))}
            onChange={(value: Kind) =>
              form.setFieldValue(
                'counted',
                !['transfer', 'card_payment', 'wallet_spend'].includes(value),
              )
            }
          />
        </Form.Item>
        <Form.Item name="name" label="ชื่อรายการ" rules={[{ required: true, whitespace: true }]}>
          <Input maxLength={160} />
        </Form.Item>
        <div className="form-pair">
          <Form.Item name="amount" label="ยอดเงิน (บาท)" rules={[{ required: true }]}>
            <Input inputMode="decimal" placeholder="0.00" />
          </Form.Item>
          <Form.Item name="date" label="วันที่" rules={[{ required: true }]}>
            <DatePicker allowClear={false} format="DD/MM/YYYY" />
          </Form.Item>
        </div>
        <div className="form-pair">
          <Form.Item name="quantity" label="จำนวน">
            <InputNumber min={0.01} />
          </Form.Item>
          <Form.Item name="unit" label="หน่วย">
            <Input placeholder="เช่น แก้ว" maxLength={40} />
          </Form.Item>
        </div>
        <Form.Item name="category" label="หมวด">
          <Select options={options(categories)} />
        </Form.Item>
        <Form.Item name="method" label="วิธีจ่าย">
          <Select options={options(methods)} />
        </Form.Item>
        <Form.Item name="counted" label="นับรวมในยอดและงบ" valuePropName="checked">
          <Switch disabled={type === 'transfer'} />
        </Form.Item>
        {slip && (
          <>
            <Form.Item name="party" label="คู่โอน">
              <Input maxLength={160} />
            </Form.Item>
            <div className="form-pair">
              <Form.Item name="reference" label="เลขอ้างอิง">
                <Input maxLength={80} />
              </Form.Item>
              <Form.Item
                name="time"
                label="เวลา"
                rules={[{ pattern: /^(?:[01]\d|2[0-3]):[0-5]\d$/, message: 'ใช้รูปแบบ HH:MM' }]}
              >
                <Input type="time" />
              </Form.Item>
            </div>
          </>
        )}
        {original && (
          <Form.Item name="flagged" valuePropName="checked">
            <Checkbox>AI ตีความผิด</Checkbox>
          </Form.Item>
        )}
      </Form>
    </Drawer>
  )
}
