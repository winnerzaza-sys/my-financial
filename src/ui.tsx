import {
  Alert,
  App,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  List,
  Progress,
  Segmented,
  Select,
  Space,
  Statistic,
  Tag,
} from 'antd'
import {
  AppstoreOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  CalendarOutlined,
  CameraOutlined,
  CloudOutlined,
  LeftOutlined,
  MessageOutlined,
  PlusOutlined,
  RightOutlined,
  SendOutlined,
  WalletOutlined,
} from '@ant-design/icons'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  baht,
  categories,
  incoming,
  interpret,
  methods,
  money,
  period,
  shiftDate,
  summarize,
  thaiToday,
  type Range,
  type TransactionInput,
} from './domain'
import {
  filtered,
  openLedger,
  roomKey,
  type Filter,
  type Ledger,
  type Operation,
  type Transaction,
} from './repository'
import { baseItem, kindLabel, signed, TransactionForm } from './controls'
import { analyzeText, findDuplicates, readSlip } from './recognition'
import { Account, useAccount, useSync } from './sync'
import { transferFileLimit } from './transfer'

const ranges = [
  { label: 'วัน', value: 'day' },
  { label: 'สัปดาห์', value: 'week' },
  { label: 'เดือน', value: 'month' },
] as const
const dateText = (date: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('th-TH', { ...options, timeZone: 'UTC' }).format(new Date(date + 'T00:00:00Z'))
type Snapshot = Awaited<ReturnType<Ledger['read']>>
type Edit = { id: string; initial: TransactionInput; original?: Transaction; image?: Blob; url?: string }
const empty: Snapshot = {
  items: [],
  messages: [],
  links: [],
  budgets: [],
  drafts: {},
  logs: [],
  pending: 0,
  conflicts: [],
}
const samples = ['ซื้อกาแฟ 70 บาท', 'เดือนนี้เติมน้ำมันเท่าไหร่', 'ตั้งงบเดือนนี้ 10,000']
const metricTitle = { income: 'เงินเข้า', expense: 'รายจ่าย', net: 'ยอดสุทธิ' }

export function Finance() {
  const account = useAccount()
  const [ledger, setLedger] = useState<Ledger>()
  const [error, setError] = useState('')
  useEffect(() => {
    if (!account.ready) return
    let done = false
    let opened: Ledger | undefined
    setError('')
    void openLedger(account.owner)
      .then((db) => {
        if (done) db.close()
        else {
          opened = db
          setLedger(db)
        }
      })
      .catch(() => {
        if (!done) setError('เปิดข้อมูลในเครื่องไม่ได้ ลองเปิดแอปอีกครั้ง')
      })
    return () => {
      done = true
      opened?.close()
    }
  }, [account.owner, account.ready])
  if (error)
    return (
      <main className="workspace">
        <Alert type="error" message={error} />
      </main>
    )
  if (!account.ready || !ledger || ledger.owner !== account.owner)
    return <main className="loading-screen">กำลังเปิดแชทการเงิน…</main>
  return <Workspace key={ledger.owner} ledger={ledger} account={account} />
}

function Workspace({ ledger, account }: { ledger: Ledger; account: ReturnType<typeof useAccount> }) {
  const { message, modal } = App.useApp()
  const [snap, setSnap] = useState(empty)
  const [view, setView] = useState<'chat' | 'dashboard'>('chat')
  const [range, setRange] = useState<Range>('day')
  const [offset, setOffset] = useState(0)
  const [today, setToday] = useState(thaiToday)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState('')
  const [history, setHistory] = useState<Filter>()
  const [category, setCategory] = useState<TransactionInput['category']>()
  const [method, setMethod] = useState<TransactionInput['method']>()
  const [scope, setScope] = useState('all')
  const [edit, setEdit] = useState<Edit>()
  const [budget, setBudget] = useState<string>()
  const [userPanel, setUserPanel] = useState(false)
  const [corrections, setCorrections] = useState(false)
  const [conflict, setConflict] = useState<{
    op: Operation
    remote: Awaited<ReturnType<Ledger['remote']>>
  }>()
  const upload = useRef<HTMLInputElement>(null)
  const chat = useRef<HTMLDivElement>(null)
  const editImage = useRef<string | undefined>(undefined)
  const alive = useRef(true)
  const busyRef = useRef(false)
  const transferUpload = useRef<HTMLInputElement>(null)
  const sync = useSync(ledger, account.session)
  const bounds = period(today, range, offset)
  const key = roomKey(range, bounds.start)
  const entries = filtered(snap.items, bounds)
  const totals = summarize(entries.map((row) => row.data))
  const currentBudget =
    range === 'month'
      ? snap.budgets.find((row) => row.data.month === bounds.start)?.data.amount
      : undefined
  const roomMessages = snap.messages.filter((row) => row.data.roomId === `room:${key}`)
  const activeDraft = snap.drafts[key]
  const formatRange =
    range === 'month'
      ? dateText(bounds.start, { month: 'long', year: 'numeric' })
      : range === 'day'
        ? dateText(bounds.start, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })
        : dateText(bounds.start, { day: 'numeric', month: 'short' }) +
          ' – ' +
          dateText(shiftDate(bounds.end, -1), { day: 'numeric', month: 'short', year: 'numeric' })

  useEffect(() => {
    alive.current = true
    const refresh = () => {
      void ledger
        .read()
        .then((value) => {
          if (alive.current) setSnap(value)
        })
        .catch(console.error)
    }
    refresh()
    const stop = ledger.subscribe(refresh)
    const timer = window.setInterval(() => setToday(thaiToday()), 15000)
    const focus = () => setToday(thaiToday())
    document.addEventListener('visibilitychange', focus)
    return () => {
      alive.current = false
      stop()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', focus)
      if (editImage.current) URL.revokeObjectURL(editImage.current)
    }
  }, [ledger])
  useEffect(() => {
    chat.current?.scrollTo({ top: chat.current.scrollHeight })
  }, [roomMessages.length, key])
  function report(err: unknown) {
    void message.error(err instanceof Error ? err.message : 'ดำเนินการไม่สำเร็จ')
  }
  async function submit(value: string) {
    const text = value.trim()
    if (!text || text.length > 600 || busyRef.current) return
    busyRef.current = true
    setBusy('กำลังอ่านข้อความ…')
    try {
      const draft = (await ledger.read()).drafts[key]
      const local = interpret(text, today, draft?.items)
      const result = draft
        ? { intent: local }
        : await analyzeText(text, today, local, (status) => {
            if (alive.current) setBusy(status)
          })
      if (!alive.current) return
      await ledger.send(key, text, result.intent, today, draft?.id, result.ai)
      setInput('')
      if (result.notice) void message.info(result.notice)
    } catch (err) {
      report(err)
    } finally {
      busyRef.current = false
      if (alive.current) setBusy('')
    }
  }
  function manual() {
    setEdit({ id: crypto.randomUUID(), initial: baseItem(range === 'day' ? bounds.start : today) })
  }
  function closeEdit() {
    if (editImage.current) URL.revokeObjectURL(editImage.current)
    editImage.current = undefined
    setEdit(undefined)
  }
  async function openEdit(row: Transaction) {
    const image = await ledger.image(row.id)
    if (!alive.current) return
    const url = image ? URL.createObjectURL(image) : undefined
    editImage.current = url
    setEdit({ id: row.id, initial: row.data, original: row, image, url })
  }
  async function attach(image?: File) {
    if (!image || busyRef.current) return
    if (!image.type.startsWith('image/') || image.size > 15 * 1024 * 1024) {
      void message.error('เลือกรูปภาพขนาดไม่เกิน 15 MB')
      return
    }
    busyRef.current = true
    setBusy('กำลังอ่านสลิป…')
    let url: string | undefined
    try {
      url = URL.createObjectURL(image)
      const parsed = await readSlip(image, today, (status) => {
        if (alive.current) setBusy(status)
      })
      if (!alive.current) {
        URL.revokeObjectURL(url)
        return
      }
      editImage.current = url
      setEdit({
        id: crypto.randomUUID(),
        initial: { ...baseItem(today), name: 'โอนเงิน', method: 'โอน', ...parsed.fields },
        image,
        url,
      })
      if (parsed.notice) void message.info(parsed.notice)
    } catch (err) {
      if (url) URL.revokeObjectURL(url)
      report(err)
    } finally {
      busyRef.current = false
      if (alive.current) setBusy('')
    }
  }
  function showHistory(filter: Filter) {
    setCategory(filter.category)
    setMethod(undefined)
    setScope('all')
    setHistory(filter)
  }
  function switchView(next: 'chat' | 'dashboard') {
    if (next === view) return
    setView(next)
    setRange(next === 'chat' ? 'day' : 'month')
    setOffset(0)
  }
  function downloadJson(value: unknown, filename: string) {
    const file = new Blob([JSON.stringify(value, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(file)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function exportLogs() {
    downloadJson(await ledger.exportLogs(), `corrections-${today}.json`)
  }
  async function exportTransfer() {
    downloadJson(await ledger.exportTransfer(), `my-financial-transfer-${today}.json`)
  }
  async function importTransfer(file: File) {
    if (file.size > transferFileLimit) throw new Error('เลือกไฟล์ JSON ขนาดไม่เกิน 50 MB')
    let value: unknown
    try {
      value = JSON.parse(await file.text())
    } catch {
      throw new Error('เปิดไฟล์ JSON ไม่ได้ กรุณาเลือกไฟล์ย้ายข้อมูลจาก My Financial')
    }
    const result = await ledger.importTransfer(value)
    if (result.added === 0) void message.info('ไม่มีข้อมูลใหม่ให้เพิ่ม')
    else
      void message.success(
        account.session
          ? `นำเข้า ${result.transactions} ธุรกรรมแล้ว ข้อมูลเข้าคิวซิงก์`
          : `นำเข้า ${result.transactions} ธุรกรรมบนเครื่องนี้แล้ว`,
      )
  }
  function clearChatInput(event: FormEvent) {
    event.preventDefault()
    void submit(input)
  }
  const historyEntries = history
    ? filtered(snap.items, { ...history, category })
        .filter(
          (row) =>
            (!method || row.data.method === method) &&
            (!history.metric ||
              (row.data.counted &&
                row.data.type !== 'transfer' &&
                (history.metric === 'net' ||
                  (history.metric === 'income') === incoming(row.data.type)))),
        )
        .sort((a, b) => b.data.date.localeCompare(a.data.date) || b.createdAt.localeCompare(a.createdAt))
    : []
  const status = snap.conflicts.length
    ? 'ข้อมูลขัดกัน'
    : sync.running
      ? 'กำลังซิงก์'
      : snap.pending
        ? `รอซิงก์ ${snap.pending} ชุด`
        : sync.error
          ? 'ซิงก์ไม่สำเร็จ'
          : !sync.online
            ? 'ออฟไลน์'
            : account.session
              ? 'เชื่อมบัญชีแล้ว'
              : 'ใช้บนเครื่องนี้'

  return (
    <div className="app-frame">
      <header className="app-header">
        <div className="header-inner">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">฿</span>
            <div>
              <strong>แชทรายรับ–รายจ่าย</strong>
              <span>บันทึกและดูยอดในที่เดียว</span>
            </div>
          </div>
          <Button className="account-button" icon={<CloudOutlined />} onClick={() => setUserPanel(true)}>
            {status}
          </Button>
        </div>
      </header>
      <main className={'workspace ' + view}>
        <div className="section-heading">
          <h1>{view === 'chat' ? 'แชทการเงิน' : 'แดชบอร์ด'}</h1>
          <Button
            icon={view === 'chat' ? <PlusOutlined /> : <WalletOutlined />}
            onClick={view === 'chat' ? manual : () => showHistory(bounds)}
          >
            {view === 'chat' ? 'กรอกเอง' : 'ดูรายการ'}
          </Button>
        </div>
        <section className="calendar-panel" aria-label="เลือกช่วงเวลา">
          <Segmented<Range>
            options={[...ranges]}
            value={range}
            onChange={(next) => {
              setRange(next)
              setOffset(0)
            }}
          />
          <div className="range-nav">
            <Button
              type="text"
              icon={<LeftOutlined />}
              aria-label="ช่วงก่อนหน้า"
              onClick={() => setOffset(offset - 1)}
            />
            <button
              className="range-label"
              onClick={() => setOffset(0)}
              aria-label={`${formatRange} กลับช่วงปัจจุบัน`}
            >
              <CalendarOutlined /> {formatRange}
            </button>
            <Button
              type="text"
              icon={<RightOutlined />}
              aria-label="ช่วงถัดไป"
              onClick={() => setOffset(offset + 1)}
            />
          </div>
        </section>
        {view === 'chat' ? (
          <>
            <div className="conversation" ref={chat} aria-live="polite">
              {!roomMessages.length && (
                <section className="welcome">
                  <span className="welcome-mark" aria-hidden="true">฿</span>
                  <h2>วันนี้มีรายการอะไรบ้าง?</h2>
                  <p>พิมพ์รายรับหรือรายจ่ายพร้อมยอดเงิน หรือแนบสลิปเพื่อตรวจข้อมูลก่อนบันทึก</p>
                  <div className="suggestions">
                    {samples.map((sample) => (
                      <Button key={sample} size="small" onClick={() => setInput(sample)}>
                        {sample}
                      </Button>
                    ))}
                  </div>
                </section>
              )}
              {roomMessages.map((entry) => {
                const data = entry.data
                const links = snap.links
                  .filter((link) => link.data.messageId === entry.id)
                  .sort((a, b) => (a.data.position ?? 0) - (b.data.position ?? 0))
                const linked = links.flatMap((link) =>
                  snap.items.filter((item) => item.id === link.data.transactionId),
                )
                const canUndo =
                  links.length === linked.length &&
                  links.every((link) =>
                    linked.some(
                      (item) =>
                        item.id === link.data.transactionId && item.revision === link.data.revision,
                    ),
                  )
                const result = data.filter
                const total = result
                  ? summarize(filtered(snap.items, result).map((row) => row.data))[
                      result.metric ?? 'expense'
                    ]
                  : 0
                return (
                  <div className={'chat-row ' + data.role} key={entry.id}>
                    {data.role === 'assistant' && <span className="avatar" aria-hidden="true">฿</span>}
                    <div className="chat-bubble">
                      {data.text && <div>{data.text}</div>}
                      {result && (
                        <div className="query-result">
                          <strong>฿{baht(total)}</strong>
                          <Button type="link" onClick={() => showHistory(result)}>
                            ดูรายการ
                          </Button>
                        </div>
                      )}
                      {links.length > 0 &&
                        (linked.length ? (
                          <div className="batch">
                            {linked.map((item) => (
                              <button
                                key={item.id}
                                className="batch-item"
                                onClick={() => void openEdit(item).catch(report)}
                              >
                                <span>
                                  {item.data.name}
                                  <small>
                                    {kindLabel[item.data.type]}
                                    {!item.data.counted && ' · แยกจากยอดรวม'}
                                  </small>
                                </span>
                                <strong className={incoming(item.data.type) ? 'positive' : 'negative'}>
                                  {signed(item.data)}
                                </strong>
                              </button>
                            ))}
                            <div className="batch-total">
                              <span>ยอดสุทธิ</span>
                              <strong>
                                {summarize(linked.map((x) => x.data)).net > 0 ? '+' : ''}฿
                                {baht(summarize(linked.map((x) => x.data)).net)}
                              </strong>
                            </div>
                            {canUndo && (
                              <Button
                                type="link"
                                size="small"
                                onClick={() => void ledger.undo(entry.id).catch(report)}
                              >
                                ย้อนกลับการบันทึก
                              </Button>
                            )}
                          </div>
                        ) : (
                          <span className="muted">รายการถูกลบแล้ว</span>
                        ))}
                    </div>
                  </div>
                )
              })}
              {activeDraft && (
                <div className="draft-bar">
                  <span>มีร่างรอคำตอบ</span>
                  <Button
                    type="link"
                    size="small"
                    onClick={() => void ledger.cancelDraft(key, activeDraft.id).catch(report)}
                  >
                    ยกเลิกร่าง
                  </Button>
                </div>
              )}
            </div>
            <form className="composer" onSubmit={clearChatInput}>
              {busy && (
                <div className="busy-text" role="status">
                  {busy}
                </div>
              )}
              <div className="composer-line">
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  ref={upload}
                  onChange={(event) => {
                    void attach(event.target.files?.[0])
                    event.target.value = ''
                  }}
                />
                <Button
                  disabled={Boolean(busy)}
                  icon={<CameraOutlined />}
                  aria-label="แนบสลิป"
                  onClick={() => upload.current?.click()}
                />
                <Input
                  aria-label="ข้อความ"
                  placeholder={activeDraft ? 'พิมพ์คำตอบของคุณ' : 'เช่น ซื้อกาแฟ 70 บาท'}
                  value={input}
                  maxLength={600}
                  onChange={(event) => setInput(event.target.value)}
                />
                <Button
                  className="send"
                  type="primary"
                  aria-label="ส่งข้อความ"
                  disabled={!input.trim()}
                  loading={Boolean(busy)}
                  htmlType="submit"
                  icon={<SendOutlined />}
                />
              </div>
            </form>
            <section className="chat-summary" aria-label="สรุปยอดช่วงที่เลือก">
              {(['income', 'expense', 'net'] as const).map((metric) => (
                <div key={metric}>
                  <span>{metricTitle[metric]}</span>
                  <strong className={metric === 'income' ? 'positive' : metric === 'expense' ? 'negative' : undefined}>
                    {metric === 'net' && totals.net > 0 ? '+' : ''}฿{baht(totals[metric])}
                  </strong>
                  {metric === 'income' && totals.refunds > 0 && (
                    <small>รวมเงินคืน ฿{baht(totals.refunds)}</small>
                  )}
                </div>
              ))}
            </section>
          </>
        ) : (
          <div className="dashboard-content">
            <section className="metrics" aria-label="สรุปยอด">
              {(['income', 'expense', 'net'] as const).map((metric) => (
                <button
                  key={metric}
                  className={'metric ' + metric}
                  onClick={() => showHistory({ ...bounds, metric })}
                >
                  <Statistic
                    title={metricTitle[metric]}
                    value={totals[metric] / 100}
                    formatter={() => '฿' + baht(totals[metric])}
                    prefix={
                      metric === 'income' ? (
                        <ArrowDownOutlined />
                      ) : metric === 'expense' ? (
                        <ArrowUpOutlined />
                      ) : (
                        <WalletOutlined />
                      )
                    }
                  />
                  {metric === 'income' && totals.refunds > 0 && (
                    <small>เงินคืน ฿{baht(totals.refunds)}</small>
                  )}
                </button>
              ))}
            </section>
            {range === 'month' && (
              <Card
                className="budget-card"
                title="งบรายเดือน"
                extra={
                  <Button type="link" onClick={() => setBudget(bounds.start)}>
                    {currentBudget === undefined ? 'ตั้งงบ' : 'แก้งบ'}
                  </Button>
                }
              >
                {currentBudget === undefined ? (
                  <p className="muted">ตั้งงบเพื่อดูว่าช่วงนี้เหลือใช้เท่าไหร่</p>
                ) : (
                  <>
                    <div className="amount-line">
                      <strong>฿{baht(totals.expense)}</strong>
                      <span>จาก ฿{baht(currentBudget)}</span>
                    </div>
                    <Progress
                      percent={
                        currentBudget > 0
                          ? Math.min(100, Math.round((totals.expense / currentBudget) * 100))
                          : totals.expense
                            ? 100
                            : 0
                      }
                      status={totals.expense > currentBudget ? 'exception' : 'normal'}
                      showInfo={false}
                    />
                    <span>
                      {totals.expense > currentBudget ? 'เกินงบ' : 'เหลือ'} ฿
                      {baht(Math.abs(currentBudget - totals.expense))}
                    </span>
                  </>
                )}
              </Card>
            )}
            <Card className="categories-card" title="รายจ่ายตามหมวด">
              {!totals.byCategory.size && <p className="muted">ยังไม่มีรายจ่ายในช่วงนี้</p>}
              {Array.from(totals.byCategory)
                .sort((a, b) => b[1] - a[1])
                .map(([label, amount]) => (
                  <button
                    className="category-row"
                    key={label}
                    onClick={() => showHistory({ ...bounds, category: label, metric: 'expense' })}
                  >
                    <span>{label}</span>
                    <strong>฿{baht(amount)}</strong>
                    <Progress
                      showInfo={false}
                      strokeColor="var(--expense)"
                      percent={Math.round((amount / totals.expense) * 100)}
                    />
                  </button>
                ))}
            </Card>
          </div>
        )}
      </main>
      <nav className="bottom-nav" aria-label="หน้าหลัก">
        <div>
          <button
            className={view === 'chat' ? 'selected' : ''}
            aria-current={view === 'chat' ? 'page' : undefined}
            onClick={() => switchView('chat')}
          >
            <MessageOutlined aria-hidden="true" />
            แชท
          </button>
          <button
            className={view === 'dashboard' ? 'selected' : ''}
            aria-current={view === 'dashboard' ? 'page' : undefined}
            onClick={() => switchView('dashboard')}
          >
            <AppstoreOutlined aria-hidden="true" />
            แดชบอร์ด
          </button>
        </div>
      </nav>
      <Drawer
        placement="bottom"
        height="min(84dvh, 790px)"
        title="ประวัติรายการ"
        open={Boolean(history)}
        onClose={() => setHistory(undefined)}
      >
        {history && (
          <div className="drawer-body">
            <Space className="history-filters" wrap>
              <Select
                value={scope}
                aria-label="ช่วงเวลา"
                options={[
                  { value: 'all', label: 'ช่วงที่เปิด' },
                  ...ranges.map((x) => ({ value: x.value, label: x.label })),
                ]}
                onChange={(value) => {
                  setScope(value)
                  setHistory(value === 'all' ? bounds : { ...history, ...period(today, value as Range) })
                }}
              />
              <Select
                allowClear
                value={category}
                aria-label="หมวด"
                placeholder="ทุกหมวด"
                onChange={setCategory}
                options={categories.map((value) => ({ value, label: value }))}
              />
              <Select
                allowClear
                value={method}
                aria-label="วิธีจ่าย"
                placeholder="ทุกวิธีจ่าย"
                onChange={setMethod}
                options={methods.map((value) => ({ value, label: value }))}
              />
            </Space>
            <div className="muted">
              {history.start} ถึง {shiftDate(history.end, -1)}
            </div>
            <List
              dataSource={historyEntries}
              locale={{ emptyText: 'ไม่มีรายการในช่วงนี้' }}
              renderItem={(row) => (
                <List.Item>
                  <button className="history-row" onClick={() => void openEdit(row).catch(report)}>
                    <span>
                      {row.data.name}
                      <small>
                        {row.data.date} · {row.data.category} · {row.data.method}
                        {!row.data.counted && ' · แยกจากยอดรวม'}
                      </small>
                    </span>
                    <strong className={incoming(row.data.type) ? 'positive' : 'negative'}>
                      {signed(row.data)}
                    </strong>
                  </button>
                </List.Item>
              )}
            />
          </div>
        )}
      </Drawer>
      {edit && (
        <TransactionForm
          key={edit.id}
          initial={edit.initial}
          original={edit.original}
          imageUrl={edit.url}
          onClose={closeEdit}
          getDuplicates={
            !edit.original && edit.image ? (value) => findDuplicates(value, snap.items) : undefined
          }
          onSave={async (value, flagged) => {
            if (edit.original) await ledger.edit(edit.original, value, flagged)
            else await ledger.add(key, value, edit.image)
            closeEdit()
            void message.success('บันทึกแล้ว')
          }}
          onRemove={
            edit.original
              ? () => {
                  const row = edit.original!
                  modal.confirm({
                    title: 'ลบรายการนี้?',
                    okText: 'ลบ',
                    cancelText: 'ยกเลิก',
                    okButtonProps: { danger: true },
                    async onOk() {
                      await ledger.remove(row).then(closeEdit).catch(report)
                    },
                  })
                }
              : undefined
          }
        />
      )}
      {budget && (
        <Drawer
          placement="bottom"
          height={285}
          open
          title="งบรายเดือน"
          onClose={() => setBudget(undefined)}
        >
          <Form
            className="drawer-body"
            layout="vertical"
            initialValues={{ amount: currentBudget === undefined ? '' : String(currentBudget / 100) }}
            onFinish={async ({ amount }) => {
              const cents = money(amount)
              if (cents === null) {
                report(new Error('ระบุยอดงบเป็นบาท'))
                return
              }
              try {
                await ledger.setBudget(budget, cents)
                setBudget(undefined)
              } catch (err) {
                report(err)
              }
            }}
          >
            <Form.Item
              name="amount"
              label={dateText(budget, { month: 'long', year: 'numeric' })}
              rules={[{ required: true }]}
            >
              <Input aria-label="งบ (บาท)" suffix="บาท" inputMode="decimal" />
            </Form.Item>
            <Button htmlType="submit" type="primary">
              บันทึกงบ
            </Button>
          </Form>
        </Drawer>
      )}
      <Drawer
        placement="bottom"
        height="min(88dvh, 740px)"
        title="บัญชีและข้อมูลในเครื่อง"
        open={userPanel}
        onClose={() => setUserPanel(false)}
      >
        <div className="drawer-body settings">
          <Account account={account} ledger={ledger} />
          {sync.error && (
            <Alert
              type="error"
              showIcon
              message={sync.error}
              action={<Button onClick={sync.retry}>ลองอีกครั้ง</Button>}
            />
          )}
          {snap.conflicts.map((op) => (
            <Alert
              key={op.id}
              type="warning"
              showIcon
              message="มีการแก้ไขจากอีกเครื่อง"
              action={
                <Button
                  onClick={() =>
                    void ledger
                      .remote(op)
                      .then((remote) => setConflict({ op, remote }))
                      .catch(report)
                  }
                >
                  เลือกข้อมูล
                </Button>
              }
            />
          ))}
          <div>
            <p>ไฟล์ย้ายข้อมูลรวมรายการ แชท และงบประมาณ เก็บไฟล์ไว้ในที่ส่วนตัว</p>
            <Space wrap>
              <Button onClick={() => void exportTransfer().catch(report)}>
                ดาวน์โหลดไฟล์ย้ายข้อมูล
              </Button>
              <Button onClick={() => transferUpload.current?.click()}>
                {account.session ? 'นำเข้าไฟล์เข้าบัญชีนี้' : 'นำเข้าไฟล์ลงเครื่องนี้'}
              </Button>
              <input
                ref={transferUpload}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0]
                  event.currentTarget.value = ''
                  if (file) void importTransfer(file).catch(report)
                }}
              />
            </Space>
          </div>
          <Space wrap>
            <Button onClick={() => setCorrections(true)}>ประวัติการแก้ไข</Button>
            <Button onClick={() => void exportLogs().catch(report)}>ส่งออกประวัติการแก้ไข</Button>
          </Space>
        </div>
      </Drawer>
      <Drawer
        placement="bottom"
        height="min(85dvh, 700px)"
        title="ประวัติการแก้ไข"
        open={corrections}
        onClose={() => setCorrections(false)}
      >
        <List
          className="drawer-body"
          dataSource={[...snap.logs].sort((a, b) => b.at.localeCompare(a.at))}
          locale={{ emptyText: 'ยังไม่มีประวัติการแก้ไข' }}
          renderItem={(log) => (
            <List.Item>
              <div>
                <Tag color={log.flagged ? 'orange' : 'blue'}>
                  {log.flagged ? 'AI ตีความผิด' : 'แก้ไขทั่วไป'}
                </Tag>
                <span>{log.after.name}</span>
                <div>
                  {signed(log.before)} → {signed(log.after)}
                </div>
                {log.source && <div className="muted">ข้อความเดิม {log.source}</div>}
                <small>{new Date(log.at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}</small>
              </div>
            </List.Item>
          )}
        />
      </Drawer>
      {conflict && (
        <Drawer
          placement="bottom"
          height="min(85dvh, 680px)"
          title="เลือกข้อมูลที่จะเก็บ"
          open
          onClose={() => setConflict(undefined)}
        >
          <div className="drawer-body">
            <List
              dataSource={conflict.op.changes.map((entry, index) => ({
                local: entry.row,
                remote: conflict.remote[index],
              }))}
              renderItem={({ local, remote }) => (
                <List.Item>
                  <div>
                    {local.entity === 'transaction'
                      ? local.data.name
                      : local.entity === 'budget'
                        ? 'งบ ' + local.data.month
                        : local.entity === 'message'
                          ? 'ข้อความแชท'
                          : 'ข้อมูลห้องหรือชุดรายการ'}
                    <div className="muted">
                      เครื่องนี้{' '}
                      {local.deletedAt
                        ? 'ลบแล้ว'
                        : local.entity === 'transaction'
                          ? signed(local.data)
                          : local.entity === 'budget'
                            ? '฿' + baht(local.data.amount)
                            : 'มีข้อมูล'}{' '}
                      · อีกเครื่อง{' '}
                      {remote?.deletedAt
                        ? 'ลบแล้ว'
                        : remote?.entity === 'transaction'
                          ? signed(remote.data)
                          : remote?.entity === 'budget'
                            ? '฿' + baht(remote.data.amount)
                            : remote
                              ? 'มีข้อมูล'
                              : 'ไม่มีรายการ'}
                    </div>
                  </div>
                </List.Item>
              )}
            />
            <p className="muted">การใช้ข้อมูลอีกเครื่องจะทิ้งการแก้ไขในคิวที่ต่อจากชุดนี้</p>
            <Space wrap>
              {[true, false].map((keep) => (
                <Button
                  key={String(keep)}
                  type={keep ? 'primary' : 'default'}
                  onClick={() =>
                    void ledger
                      .resolve(conflict.op, keep)
                      .then(() => {
                        setConflict(undefined)
                        sync.retry()
                      })
                      .catch(report)
                  }
                >
                  {keep ? 'ใช้ข้อมูลเครื่องนี้' : 'ใช้ข้อมูลอีกเครื่อง'}
                </Button>
              ))}
            </Space>
          </div>
        </Drawer>
      )}
    </div>
  )
}
