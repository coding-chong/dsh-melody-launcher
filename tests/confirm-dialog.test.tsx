// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from '../src/components/dialogs/ConfirmDialog'
import type { ManagedPlugin } from '../src/types'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.innerHTML = ''
})

const plugin: ManagedPlugin = {
  packageName: 'dsh-rewind-plugin',
  displayName: 'Rewind',
  description: '',
  version: '0.15.3',
  enabled: false,
  builtin: false,
  locked: false,
  compatible: true,
  order: 0,
}

async function mount() {
  const onCancel = vi.fn()
  const onConfirm = vi.fn()
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(<ConfirmDialog plugin={plugin} onCancel={onCancel} onConfirm={onConfirm} />))
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent?.trim() === label)!
  return { onCancel, onConfirm, button }
}

describe('ConfirmDialog uninstall scope', () => {
  it('offers both scopes so a shared plugin is not silently removed everywhere', async () => {
    const { button } = await mount()
    expect(button('取消')).toBeTruthy()
    expect(button('仅从当前 Profile 移除')).toBeTruthy()
    expect(button('彻底清除')).toBeTruthy()
  })

  it('reports the profile-only scope', async () => {
    const { button, onConfirm } = await mount()
    await act(async () => button('仅从当前 Profile 移除').click())
    expect(onConfirm).toHaveBeenCalledWith('profile')
  })

  it('reports the purge scope', async () => {
    const { button, onConfirm } = await mount()
    await act(async () => button('彻底清除').click())
    expect(onConfirm).toHaveBeenCalledWith('purge')
  })

  it('treats cancel as a no-op on scope', async () => {
    const { button, onCancel, onConfirm } = await mount()
    await act(async () => button('取消').click())
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
