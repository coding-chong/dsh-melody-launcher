// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LauncherApiProvider } from '../src/api/client'
import { demoApi } from '../src/demo-api'
import { useLauncherStore } from '../src/hooks/use-launcher-store'
import type { CustomApiProvider, LauncherApi, ProfileSummary } from '../src/types'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * 自定义模型服务是 Profile 作用域的数据（写在 Profile 自己的 cordis.patch.yml 里）。
 * 任何切换当前 Profile 的动作都必须重读它，否则顶栏会一直显示上一个 Profile 的
 * 结论——同一个启动器里，磁盘上明明是 1 个 provider，界面却写「未配置」。
 */

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.innerHTML = ''
})

const provider = (route: string): CustomApiProvider => ({
  route,
  displayName: route,
  baseUrl: 'https://api.example.invalid/provider/v1',
  protocol: 'openai-responses',
  modelIds: ['deepseek/deepseek-v4.1-flash'],
  credentialName: `${route.toUpperCase()}_API_KEY`,
  hasApiKey: true,
})

async function mountStore(overrides: Partial<LauncherApi>) {
  let store: ReturnType<typeof useLauncherStore>
  function Harness() {
    store = useLauncherStore()
    return null
  }
  const api: LauncherApi = { ...demoApi, ...overrides }
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(<LauncherApiProvider value={api}><Harness /></LauncherApiProvider>))
  await act(async () => { /* 等启动期并行加载落定 */ })
  expect(store!.loading).toBe(false)
  // getter：每次读取都拿最近一次渲染的 store，避免拿到旧闭包里的数组。
  return { api, get store() { return store } }
}

describe('Profile-scoped custom API providers', () => {
  it('re-reads the provider list after switching Profile', async () => {
    const base = (await demoApi.listProfiles())[0]
    const summary = (id: string): ProfileSummary => ({
      ...base, id, name: id, selected: id === 'web', missingDependencies: [],
    })
    const settings = await demoApi.getSettings()
    let currentProfile = 'web'
    const mounted = await mountStore({
      listProfiles: async () => [summary('web'), summary('alpha')],
      switchProfile: async profileName => {
        currentProfile = profileName
        return { ...settings, profileName }
      },
      listCustomApiProviders: async () => (currentProfile === 'web' ? [provider('commandcodedirect')] : []),
    })

    // 启动时 Profile 是 web → 1 个自定义服务。
    expect(mounted.store.customApiProviders.map(item => item.route)).toEqual(['commandcodedirect'])

    await act(async () => { await mounted.store.switchProfile('alpha') })
    expect(mounted.store.settings?.profileName).toBe('alpha')
    expect(mounted.store.customApiProviders).toEqual([])

    // 切回声明了 llm-pi-ai 的 Profile，列表必须跟着回来——这就是原来的失败点。
    await act(async () => { await mounted.store.switchProfile('web') })
    expect(mounted.store.settings?.profileName).toBe('web')
    expect(mounted.store.customApiProviders.map(item => item.route)).toEqual(['commandcodedirect'])
  })

  it('keeps the provider list fresh even when a sibling refresh throws', async () => {
    let currentProfile = 'web'
    const mounted = await mountStore({
      saveSettings: async next => {
        currentProfile = next.profileName
        return next
      },
      detectDshInstallation: vi.fn(async () => { throw new Error('安装探测失败') }),
      listCustomApiProviders: vi.fn(async () => (currentProfile === 'web' ? [provider('commandcodedirect')] : [])),
    })
    vi.mocked(mounted.api.listCustomApiProviders).mockClear()

    const saved = await act(async () => mounted.store.saveSettings({ ...mounted.store.settings!, profileName: 'web' }))
    expect(saved).toBe(true)
    // 探测失败不能连坐「自定义 API 列表」：保存后它必须被重新读取。
    expect(mounted.api.listCustomApiProviders).toHaveBeenCalled()
    expect(mounted.store.customApiProviders.map(item => item.route)).toEqual(['commandcodedirect'])
  })
})
