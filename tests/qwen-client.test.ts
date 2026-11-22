import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { interpret } from '../src/domain'

class TestWorker extends EventTarget {
  static instances: TestWorker[] = []
  terminated = false
  constructor() { super(); TestWorker.instances.push(this) }
  postMessage() {}
  terminate() { this.terminated = true }
  reply(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data })) }
}

beforeEach(() => {
  vi.resetModules()
  TestWorker.instances = []
  vi.stubGlobal('Worker', TestWorker)
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('navigator', { gpu: {} })
  vi.stubEnv('VITE_ENABLE_QWEN', 'true')
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

it('falls back after invalid model output and reuses the worker for the next successful message', async () => {
  const { analyzeText } = await import('../src/recognition')
  const local = interpret('ซื้อขนม 50', '2026-11-22')
  const first = analyzeText('ซื้อขนม 50', '2026-11-22', local, () => {})
  const worker = TestWorker.instances[0]
  worker.reply({ error: 'invalid JSON', fatal: false })
  expect((await first).intent).toEqual(local)
  expect(worker.terminated).toBe(false)
  const second = analyzeText('ซื้อขนม 50', '2026-11-22', local, () => {})
  worker.reply({ result: local })
  expect(await second).toMatchObject({ intent: local, ai: { interpretation: local } })
  expect(TestWorker.instances).toHaveLength(1)
})

it('replaces a worker after a fatal model error', async () => {
  const { analyzeText } = await import('../src/recognition')
  const local = interpret('ซื้อขนม 50', '2026-11-22')
  const first = analyzeText('ซื้อขนม 50', '2026-11-22', local, () => {})
  TestWorker.instances[0].reply({ error: 'GPU device lost', fatal: true })
  expect((await first).intent).toEqual(local)
  expect(TestWorker.instances[0].terminated).toBe(true)
  const second = analyzeText('ซื้อขนม 50', '2026-11-22', local, () => {})
  TestWorker.instances[1].reply({ result: local })
  expect((await second).intent).toEqual(local)
  expect(TestWorker.instances).toHaveLength(2)
})

it('terminates a stalled worker after the timeout and can process the next message', async () => {
  vi.useFakeTimers()
  const { analyzeText } = await import('../src/recognition')
  const local = interpret('ซื้อขนม 50', '2026-11-22')
  const first = analyzeText('ซื้อขนม 50', '2026-11-22', local, () => {})
  await vi.advanceTimersByTimeAsync(180000)
  expect((await first).intent).toEqual(local)
  expect(TestWorker.instances[0].terminated).toBe(true)
  const second = analyzeText('ซื้อขนม 50', '2026-11-22', local, () => {})
  TestWorker.instances[1].reply({ result: local })
  expect(await second).toMatchObject({ intent: local, ai: { interpretation: local } })
})
