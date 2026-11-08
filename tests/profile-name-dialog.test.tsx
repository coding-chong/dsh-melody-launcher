// @vitest-environment jsdom

import { act, type ComponentProps, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { demoApi } from '../src/demo-api'
import { PacksView } from '../src/views/PacksView'
import { validProfileName } from '../src/components/dialogs/ProfileNameDialog'

/**
 * 「克隆」「新建 Profile」曾经用 window.prompt 取名字。Electron 的 renderer 不支持
 * prompt()，调用会抛错，于是两个按钮点了完全没有反应、连错误提示都没有。
 * 这里把 window.prompt 换成「一调用就抛」的实现，模拟真实 Electron 行为。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

async function render(element: ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(element))
}

function poisonPrompt() {
  const prompt = vi.fn(() => { throw new Error('prompt() is and will not be supported.') })
  Object.defineProperty(window, 'prompt', { configurable: true, writable: true, value: prompt })
  return prompt
}

async function mountPacks(onCreateProfile = vi.fn()) {
  const profiles = await demoApi.listProfiles()
  const props: ComponentProps<typeof PacksView> = {
    profiles, packs: [], profile: await demoApi.readProfile(), busy: null,
    onRefresh: vi.fn(), onCreate: vi.fn(), onImport: vi.fn(), onActivate: vi.fn(), onDeactivate: vi.fn(),
    onSwitchProfile: vi.fn(), onCreateProfile, onDeleteProfile: vi.fn(),
    onExport: vi.fn(), onExportProfile: vi.fn(), onRemove: vi.fn(),
    onAddPlugin: vi.fn(), onAddPreset: vi.fn(), onAddSkill: vi.fn(), onAddApplication: vi.fn(),
    onToggleItem: vi.fn(), onTogglePreset: vi.fn(), onToggleSkill: vi.fn(), onToggleApplication: vi.fn(),
    onRemoveItem: vi.fn(), onRemovePreset: vi.fn(), onRemoveSkill: vi.fn(), onRemoveApplication: vi.fn(),
    installedPresets: [], installedSkills: [], installedApplications: [],
  }
  await render(<PacksView {...props} />)
  return { props, profiles }
}

function buttonByText(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)
}

describe('Profile 名称输入不再依赖 window.prompt', () => {
  it('opens an in-app dialog from 克隆 and submits the name with its source', async () => {
    const prompt = poisonPrompt()
    const onCreateProfile = vi.fn()
    const { profiles } = await mountPacks(onCreateProfile)
    const source = profiles.find(profile => !profile.selected)!

    await act(async () => buttonByText('克隆')!.click())
    // window.prompt 从未被调用 —— 这就是 Electron 里「点了没反应」的根因。
    expect(prompt).not.toHaveBeenCalled()

    const input = document.querySelector<HTMLInputElement>('#profile-name-input')!
    expect(document.body.textContent).toContain(`克隆 Profile「${source.id}」`)
    expect(input.value).toBe(`${source.id}-copy`)

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'copied-env')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => buttonByText('开始克隆')!.click())

    expect(onCreateProfile).toHaveBeenCalledWith('copied-env', source.id)
    // 提交后对话框关闭。
    expect(document.querySelector('#profile-name-input')).toBeNull()
  })

  it('opens the same dialog for 新建 Profile without a clone source', async () => {
    const prompt = poisonPrompt()
    const onCreateProfile = vi.fn()
    await mountPacks(onCreateProfile)

    await act(async () => buttonByText('新建 Profile')!.click())
    expect(prompt).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('新建 Profile')

    const input = document.querySelector<HTMLInputElement>('#profile-name-input')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'fresh-env')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => buttonByText('创建')!.click())

    expect(onCreateProfile).toHaveBeenCalledWith('fresh-env')
  })

  it('refuses names that would break the Profile directory', async () => {
    poisonPrompt()
    const onCreateProfile = vi.fn()
    await mountPacks(onCreateProfile)
    await act(async () => buttonByText('克隆')!.click())

    const input = document.querySelector<HTMLInputElement>('#profile-name-input')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '../escape')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const submit = buttonByText('开始克隆') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    await act(async () => submit.click())
    expect(onCreateProfile).not.toHaveBeenCalled()

    // 与主进程同一套规则。
    expect(validProfileName('my-env_1.0')).toBe(true)
    expect(validProfileName('node_modules')).toBe(false)
    expect(validProfileName('trailing.')).toBe(true)
    expect(validProfileName('-leading')).toBe(false)
    expect(validProfileName('a'.repeat(65))).toBe(false)
  })
})
