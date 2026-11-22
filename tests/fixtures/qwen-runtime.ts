import { vi } from 'vitest'

export const env = { allowLocalModels: true, useBrowserCache: false }
export const generate = Object.assign(vi.fn(), {
  tokenizer: { apply_chat_template: () => 'test prompt' },
})
export const pipeline = vi.fn(async () => generate)
