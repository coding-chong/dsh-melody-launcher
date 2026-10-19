import type { CustomApiProtocol, CustomApiProvider, CustomApiProviderInput } from '../src/types'
import { hasCredential, readCredential, removeCredential, setCredential } from './credentials'
import {
  isRecord,
  normalizeProviderTarget,
  readProviderCatalog,
  updateProviderCatalog,
  type JsonRecord,
  type ProviderConfigTarget,
} from './provider-config'

const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const CREDENTIAL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const PROTOCOLS = new Set<CustomApiProtocol>([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
])

/** provider 配置的读写目标：Profile 组合补丁优先，旧版 DSH 退回 settings.yaml。 */
export type CustomApiTarget = string | ProviderConfigTarget

export function credentialNameForRoute(route: string): string {
  return `${route.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
}

function providerCredentialName(provider: JsonRecord): string | null {
  return typeof provider.apiKeyEnv === 'string' && CREDENTIAL_PATTERN.test(provider.apiKeyEnv)
    ? provider.apiKeyEnv
    : null
}

function modelIdsFromProvider(provider: JsonRecord): string[] {
  if (!Array.isArray(provider.models)) return []
  return provider.models.flatMap(model => {
    if (typeof model === 'string') return model.trim() ? [model.trim()] : []
    if (isRecord(model) && typeof model.id === 'string' && model.id.trim()) return [model.id.trim()]
    return []
  })
}

function normalizeInput(input: CustomApiProviderInput): Required<Omit<CustomApiProviderInput, 'originalRoute' | 'apiKey'>> & {
  originalRoute: string
  apiKey: string
} {
  if (!input || typeof input !== 'object') throw new Error('自定义 API 配置无效。')
  const route = typeof input.route === 'string' ? input.route.trim() : ''
  const originalRoute = typeof input.originalRoute === 'string' ? input.originalRoute.trim() : route
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : ''
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''

  if (!ROUTE_PATTERN.test(route) || route.length > 64) {
    throw new Error('路由只能使用小写字母、数字和横线，并且必须以字母开头。')
  }
  if (!ROUTE_PATTERN.test(originalRoute) || originalRoute.length > 64) throw new Error('原路由格式无效。')
  if (!displayName || displayName.length > 80) throw new Error('显示名称不能为空，且不能超过 80 个字符。')
  if (!PROTOCOLS.has(input.protocol)) throw new Error('API 协议不受支持。')
  if (!baseUrl || baseUrl.length > 2048) throw new Error('Base URL 不能为空。')
  let parsedUrl: URL
  try {
    parsedUrl = new URL(baseUrl)
  } catch {
    throw new Error('Base URL 不是有效的网址。')
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new Error('Base URL 必须是 HTTP(S) 地址，且不能包含账号或密码。')
  }
  if (!Array.isArray(input.modelIds)) throw new Error('模型列表格式无效。')
  const modelIds = [...new Set(input.modelIds.map(id => typeof id === 'string' ? id.trim() : ''))]
    .filter(Boolean)
  if (modelIds.length === 0) throw new Error('至少需要填写一个模型 ID。')
  if (modelIds.length > 100 || modelIds.some(id => id.length > 200 || /[\r\n\0]/.test(id))) {
    throw new Error('模型 ID 数量或格式无效。')
  }
  if (apiKey.length > 32_768) throw new Error('API Key 过长。')

  return { route, originalRoute, displayName, baseUrl, protocol: input.protocol, modelIds, apiKey }
}

function preservedModels(existing: JsonRecord | undefined, modelIds: string[]): Array<JsonRecord> {
  const existingModels = Array.isArray(existing?.models) ? existing.models : []
  const byId = new Map<string, JsonRecord>()
  for (const model of existingModels) {
    if (isRecord(model) && typeof model.id === 'string') byId.set(model.id, model)
  }
  return modelIds.map(id => ({ ...(byId.get(id) ?? {}), id }))
}

export async function listCustomApiProviders(target: CustomApiTarget): Promise<CustomApiProvider[]> {
  const resolved = normalizeProviderTarget(target)
  const { providers } = await readProviderCatalog(resolved)
  const parsed = Object.entries(providers).flatMap(([route, value]) => {
    if (!ROUTE_PATTERN.test(route) || !isRecord(value)) return []
    const protocol = value.api
    const baseUrl = value.baseURL
    const modelIds = modelIdsFromProvider(value)
    if (!PROTOCOLS.has(protocol as CustomApiProtocol) || typeof baseUrl !== 'string' || modelIds.length === 0) return []
    return [{
      route,
      displayName: typeof value.displayName === 'string' && value.displayName.trim() ? value.displayName.trim() : route,
      baseUrl,
      protocol: protocol as CustomApiProtocol,
      modelIds,
      credentialName: providerCredentialName(value),
    }]
  })

  const withStatus = await Promise.all(parsed.map(async provider => ({
    ...provider,
    hasApiKey: provider.credentialName ? await hasCredential(resolved.dshHome, provider.credentialName) : false,
  })))
  return withStatus.sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN'))
}

export async function saveCustomApiProvider(
  target: CustomApiTarget,
  input: CustomApiProviderInput,
): Promise<CustomApiProvider[]> {
  const resolved = normalizeProviderTarget(target)
  const normalized = normalizeInput(input)
  const { providers } = await readProviderCatalog(resolved)
  const existing = isRecord(providers[normalized.originalRoute])
    ? JSON.parse(JSON.stringify(providers[normalized.originalRoute])) as JsonRecord
    : undefined
  const oldCredentialName = existing ? providerCredentialName(existing) : null
  const routeChanged = normalized.originalRoute !== normalized.route
  if (routeChanged && providers[normalized.route] !== undefined) throw new Error('目标路由已存在，请换一个路由名称。')

  let nextCredentialName: string | null = !routeChanged && oldCredentialName
    ? oldCredentialName
    : null
  if (normalized.apiKey) {
    nextCredentialName = routeChanged || !oldCredentialName ? credentialNameForRoute(normalized.route) : oldCredentialName
    await setCredential(resolved.dshHome, nextCredentialName, normalized.apiKey)
  } else if (routeChanged && oldCredentialName) {
    const migratedSecret = await readCredential(resolved.dshHome, oldCredentialName)
    if (migratedSecret) {
      nextCredentialName = credentialNameForRoute(normalized.route)
      await setCredential(resolved.dshHome, nextCredentialName, migratedSecret)
    }
  }

  await updateProviderCatalog(resolved, draft => {
    if (routeChanged) delete draft[normalized.originalRoute]
    const candidate = draft[normalized.route]
    const previous: JsonRecord | undefined = isRecord(candidate) ? candidate : existing
    const next: JsonRecord = { ...(previous ?? {}) }
    next.displayName = normalized.displayName
    next.api = normalized.protocol
    next.baseURL = normalized.baseUrl
    next.models = preservedModels(previous, normalized.modelIds)
    if (nextCredentialName) next.apiKeyEnv = nextCredentialName
    else delete next.apiKeyEnv
    draft[normalized.route] = next
  })

  if (routeChanged && oldCredentialName && oldCredentialName !== nextCredentialName) {
    await removeCredential(resolved.dshHome, oldCredentialName)
  }
  return listCustomApiProviders(resolved)
}

export async function removeCustomApiProvider(
  target: CustomApiTarget,
  route: string,
): Promise<CustomApiProvider[]> {
  const resolved = normalizeProviderTarget(target)
  const normalizedRoute = typeof route === 'string' ? route.trim() : ''
  if (!ROUTE_PATTERN.test(normalizedRoute)) throw new Error('自定义 API 路由格式无效。')
  const { providers } = await readProviderCatalog(resolved)
  const existing = providers[normalizedRoute]
  if (!isRecord(existing)) throw new Error('没有找到该自定义 API。')
  const credentialName = providerCredentialName(existing) ?? credentialNameForRoute(normalizedRoute)

  await updateProviderCatalog(resolved, draft => {
    delete draft[normalizedRoute]
  })
  await removeCredential(resolved.dshHome, credentialName)
  return listCustomApiProviders(resolved)
}
