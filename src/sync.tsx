import { createClient, type Session } from '@supabase/supabase-js'
import { Alert, Button, Form, Input, Space } from 'antd'
import { useEffect, useState } from 'react'
import { openLedger, type Ledger, type Row } from './repository'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
const client =
  import.meta.env.VITE_ENABLE_CLOUD_SYNC === 'true' && url && key ? createClient(url, key) : undefined

export function useAccount() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(!client)
  useEffect(() => {
    if (!client) return
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_, next) => {
      setSession(next)
      setReady(true)
    })
    return () => subscription.unsubscribe()
  }, [])
  return { owner: session?.user.id ?? 'guest', session, ready }
}
interface PullResponse {
  rows: Row[]
  cursor: string
}
type CommitResponse = { status: 'ok' | 'conflict'; rows: Row[] }

export function useSync(ledger: Ledger, session: Session | null) {
  const [online, setOnline] = useState(navigator.onLine)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [request, setRequest] = useState(0)
  const owner = session?.user.id
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  useEffect(() => {
    if (!client || !owner || !online || owner !== ledger.owner) {
      setRunning(false)
      return
    }
    const api = client
    const controller = new AbortController()
    let active = false
    let again = false
    let timer: number | undefined
    const stopped = () => controller.signal.aborted
    async function pull() {
      while (!stopped()) {
        const cursor = await ledger.cursor()
        const { data, error } = await api
          .rpc('ledger_pull', { requested_owner: owner, after_cursor: cursor })
          .abortSignal(controller.signal)
        if (stopped()) return
        if (error) throw error
        const delta = data as PullResponse
        await ledger.merge(delta.rows, delta.cursor)
        if (delta.rows.length < 100) break
      }
    }
    async function run() {
      if (stopped() || !navigator.onLine) return
      if (active) {
        again = true
        return
      }
      active = true
      setRunning(true)
      setError('')
      try {
        await pull()
        for (const op of await ledger.pending()) {
          if (stopped() || op.status === 'conflict') break
          const { data, error } = await api
            .rpc('ledger_apply', { requested_owner: owner, operation_id: op.id, changes: op.changes })
            .abortSignal(controller.signal)
          if (stopped()) return
          if (error) throw error
          const result = data as CommitResponse
          if (result.status === 'conflict') {
            await pull()
            if (!stopped()) await ledger.reject(op)
            break
          }
          await ledger.ack(op, result.rows)
        }
        await pull()
      } catch {
        if (!stopped()) setError('ซิงก์ไม่สำเร็จ รายการยังอยู่ในเครื่องนี้')
      } finally {
        active = false
        if (!stopped()) {
          setRunning(false)
          if (again) {
            again = false
            schedule()
          }
        }
      }
    }
    function schedule() {
      if (active) return
      clearTimeout(timer)
      timer = window.setTimeout(() => void run(), 400)
    }
    const stop = ledger.subscribe(schedule)
    const visible = () => {
      if (document.visibilityState === 'visible') void run()
    }
    const poll = window.setInterval(visible, 20000)
    document.addEventListener('visibilitychange', visible)
    void run()
    return () => {
      controller.abort()
      stop()
      clearTimeout(timer)
      clearInterval(poll)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [owner, online, ledger, request])
  return { online, running, error, retry: () => setRequest((value) => value + 1) }
}
export function Account({
  account,
  ledger,
}: {
  account: ReturnType<typeof useAccount>
  ledger: Ledger
}) {
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [register, setRegister] = useState(false)
  if (!client)
    return (
      <Alert
        type="info"
        message="ข้อมูลอยู่ในเครื่องนี้"
        description="ดาวน์โหลดไฟล์ย้ายข้อมูลเพื่อเก็บสำรองหรือใช้กับบัญชีซิงก์ในอนาคต"
      />
    )
  const api = client
  async function login({ email, password }: { email: string; password: string }) {
    setBusy(true)
    setStatus('')
    try {
      const result = register
        ? await api.auth.signUp({ email, password })
        : await api.auth.signInWithPassword({ email, password })
      if (result.error) setStatus('เข้าสู่ระบบไม่สำเร็จ ตรวจอีเมล รหัสผ่าน และการเชื่อมต่อ')
      else if (register && !result.data.session)
        setStatus('ตรวจอีเมลเพื่อยืนยันบัญชี ก่อนกลับมาเข้าสู่ระบบ')
    } catch {
      setStatus('เชื่อมต่อบัญชีไม่ได้ กรุณาลองใหม่')
    } finally {
      setBusy(false)
    }
  }
  async function importGuest() {
    setBusy(true)
    setStatus('')
    try {
      const guest = await openLedger('guest')
      try {
        await ledger.importTransfer(await guest.exportTransfer())
        setStatus('ตรวจและนำเข้าข้อมูลจากโปรไฟล์ในเครื่องแล้ว')
      } finally {
        guest.close()
      }
    } catch {
      setStatus('นำเข้าข้อมูลไม่สำเร็จ กรุณาลองอีกครั้ง')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {account.session ? (
        <>
          <p>{account.session.user.email}</p>
          <Space wrap>
            <Button loading={busy} onClick={() => void importGuest()}>
              นำเข้าข้อมูลก่อนเข้าสู่ระบบ
            </Button>
            <Button
              onClick={() =>
                void api.auth.signOut({ scope: 'local' }).then(({ error }) => {
                  if (error) setStatus('ออกจากระบบไม่สำเร็จ')
                })
              }
            >
              ออกจากระบบ
            </Button>
          </Space>
        </>
      ) : (
        <Form layout="vertical" onFinish={(values) => void login(values)}>
          <Form.Item name="email" label="อีเมล" rules={[{ required: true, type: 'email' }]}>
            <Input autoComplete="email" inputMode="email" />
          </Form.Item>
          <Form.Item name="password" label="รหัสผ่าน" rules={[{ required: true, min: 6 }]}>
            <Input.Password autoComplete={register ? 'new-password' : 'current-password'} />
          </Form.Item>
          <Space wrap>
            <Button type="primary" htmlType="submit" loading={busy}>
              {register ? 'สมัครบัญชี' : 'เข้าสู่ระบบ'}
            </Button>
            <Button
              type="link"
              onClick={() => {
                setRegister(!register)
                setStatus('')
              }}
            >
              {register ? 'กลับไปเข้าสู่ระบบ' : 'สมัครบัญชี'}
            </Button>
          </Space>
        </Form>
      )}
      {status && <Alert type="info" message={status} />}
    </>
  )
}
