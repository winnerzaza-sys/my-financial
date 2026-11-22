import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const request = {
  text: 'กาแฟ 50', today: '2026-11-22', model: 'test-model', categories: [], methods: [],
}
let messages: Record<string, unknown>[]
let runtime: typeof import('./fixtures/qwen-runtime')
let scope: { postMessage: (value: Record<string, unknown>) => void; onmessage?: (event: unknown) => Promise<void> }

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  messages = []
  scope = { postMessage: (value) => messages.push(value) }
  vi.stubGlobal('self', scope)
  vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({}) } })
  vi.stubEnv('VITE_QWEN_RUNTIME', '/tests/fixtures/qwen-runtime.ts')
  runtime = await import('./fixtures/qwen-runtime')
  await import('../src/qwen.worker')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('keeps the loaded model after malformed JSON and processes the next message without loading again', async () => {
  runtime.generate.mockResolvedValueOnce([{ generated_text: 'not JSON' }])
    .mockResolvedValueOnce([{ generated_text: '{"kind":"query","range":"month"}' }])
  await scope.onmessage!({ data: request })
  expect(messages.at(-1)).toMatchObject({ error: expect.any(String), fatal: false })
  messages.length = 0
  await scope.onmessage!({ data: request })
  expect(messages.at(-1)).toEqual({ result: { kind: 'query', range: 'month' } })
  expect(messages.filter((value) => value.progress === 'กำลังเตรียม Qwen…')).toHaveLength(0)
})

it('marks GPU execution failures as fatal so the client can replace the worker', async () => {
  runtime.generate.mockRejectedValueOnce(new Error('GPU device lost'))
  await scope.onmessage!({ data: request })
  expect(messages.at(-1)).toEqual({ error: 'GPU device lost', fatal: true })
})

it('can retry initialization after a failed model load', async () => {
  runtime.pipeline.mockRejectedValueOnce(new Error('download failed'))
  runtime.generate.mockResolvedValueOnce([{ generated_text: '{"kind":"query"}' }])
  await scope.onmessage!({ data: request })
  expect(messages.at(-1)).toEqual({ error: 'download failed', fatal: true })
  await scope.onmessage!({ data: request })
  expect(messages.at(-1)).toEqual({ result: { kind: 'query' } })
})
