import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseDocument } from 'yaml'
import type { CustomApiModel, CustomApiProtocol, CustomApiProvider, CustomApiProviderInput } from '../src/types'
import { hasCredential, readCredential, removeCredential, setCredential } from './credentials'
import {
  PI_AI_ENTRY_ID,
  PI_AI_ENTRY_NAME,
  isRecord,
  normalizeProviderTarget,
  readEntryConfig,
  readProviderCatalog,
  resolveProviderConfigLocation,
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

/** 显式同步的落点：旧版 DSH 的兼容层文件，只有它需要全局镜像。 */
const LEGACY_SETTINGS_FILENAME = 'settings.yaml'
/** 默认模型也是补丁里的一条 Loader 条目，旧版 DSH 放在 settings.yaml 顶层。 */
const DEFAULT_MODEL_ENTRY = { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model' } as const

/** provider 配置的读写目标：Profile 组合补丁优先，旧版 DSH 退回 settings.yaml。 */
export type CustomApiTarget = string | ProviderConfigTarget

/**
 * 调用点统一收敛成 resolved target。
 *
 * 旧调用把 profileName 作为尾部位置参数传入（`saveCustomApiProvider(home, input, name)`），
 * 这里就地折叠进 target 对象，读写实现只保留一套。
 */
function resolveApiTarget(target: CustomApiTarget, legacyProfileName?: string | null): ProviderConfigTarget {
  const resolved = normalizeProviderTarget(target)
  if (typeof target === 'string' && legacyProfileName !== undefined && !resolved.profileName) {
    return { dshHome: resolved.dshHome, profileName: legacyProfileName ?? null }
  }
  return resolved
}

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

/** 把 YAML 里的 model 条目（字符串或对象）补全成 UI 需要的完整形状。 */
function normalizedModel(model: unknown): CustomApiModel | null {
  if (typeof model === 'string') {
    const id = model.trim()
    return id ? { id, input: ['text'], reasoningEfforts: {} } : null
  }
  if (!isRecord(model) || typeof model.id !== 'string' || !model.id.trim()) return null
  const input = Array.isArray(model.input)
    ? model.input.filter(value => value === 'text' || value === 'image') as Array<'text' | 'image'>
    : ['text'] as Array<'text' | 'image'>
  const reasoningEfforts: Record<string, string | null> = {}
  if (isRecord(model.reasoningEfforts)) {
    for (const [key, value] of Object.entries(model.reasoningEfforts)) {
      if (typeof value === 'string' || value === null) reasoningEfforts[key] = value
    }
  }
  const result: CustomApiModel = { id: model.id.trim(), input: input.length > 0 ? input : ['text'], reasoningEfforts }
  if (typeof model.name === 'string' && model.name.trim()) result.name = model.name.trim()
  if (Number.isFinite(model.contextWindow)) result.contextWindow = Number(model.contextWindow)
  if (Number.isFinite(model.maxOutputTokens)) result.maxOutputTokens = Number(model.maxOutputTokens)
  return result
}

function modelsFromProvider(provider: JsonRecord): CustomApiModel[] {
  if (!Array.isArray(provider.models)) return []
  return provider.models.map(normalizedModel).filter((model): model is CustomApiModel => model !== null)
}

/** `agent-default-model` 的 `provider/model` 展示形态，与 UI 的 `route/` 前缀比较保持一致。 */
function defaultModelLabel(config: JsonRecord): string | null {
  if (typeof config.model !== 'string' || !config.model.trim()) return null
  const model = config.model.trim()
  const provider = typeof config.provider === 'string' ? config.provider.trim() : ''
  return provider ? `${provider}/${model}` : model
}

async function readDefaultModel(target: ProviderConfigTarget): Promise<string | null> {
  const config = await readEntryConfig(target, DEFAULT_MODEL_ENTRY).catch(() => ({} as JsonRecord))
  return defaultModelLabel(config)
}

function normalizeInput(input: CustomApiProviderInput): Omit<CustomApiProviderInput, 'originalRoute' | 'apiKey'> & {
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

  const models = Array.isArray(input.models)
    ? input.models.map(normalizedModel).filter((model): model is CustomApiModel => model !== null)
    : undefined
  return { route, originalRoute, displayName, baseUrl, protocol: input.protocol, modelIds, models, apiKey }
}

/** 编辑时保留同 id 模型的既有字段（contextWindow / reasoningEfforts 等），只按 modelIds 重排。 */
function preservedModels(existing: JsonRecord | undefined, modelIds: string[]): Array<JsonRecord> {
  const existingModels = Array.isArray(existing?.models) ? existing.models : []
  const byId = new Map<string, JsonRecord>()
  for (const model of existingModels) {
    if (isRecord(model) && typeof model.id === 'string') byId.set(model.id, model)
  }
  return modelIds.map(id => ({ ...(byId.get(id) ?? {}), id }))
}

async function readSource(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** 先写同目录临时文件再 rename，避免半截文件被 DSH 读到。 */
async function writeSource(filePath: string, content: string, mode: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode, flag: 'wx' })
    await rename(temporary, filePath)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * 只改旧版兼容层的 `settings.yaml`，其它全局键（含注释）原样保留。
 *
 * 这条路径只服务于显式同步：日常读写走 provider-config 的 Profile 补丁。
 */
async function updateLegacySettings(
  dshHome: string,
  mutate: (document: ReturnType<typeof parseDocument>) => void,
): Promise<void> {
  const filePath = path.join(dshHome, LEGACY_SETTINGS_FILENAME)
  const source = await readSource(filePath)
  const document = parseDocument(source ?? '{}\n', { uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new Error('DSH settings.yaml 格式无效，请先修复配置文件后重试。')
  }
  const value = document.toJS() as unknown
  if (value !== null && !isRecord(value)) throw new Error('DSH settings.yaml 顶层必须是配置映射。')
  mutate(document)
  await writeSource(filePath, document.toString({ lineWidth: 0 }), 0o600)
}

export async function listCustomApiProviders(target: CustomApiTarget): Promise<CustomApiProvider[]> {
  const resolved = normalizeProviderTarget(target)
  const { providers } = await readProviderCatalog(resolved)
  const defaultModel = await readDefaultModel(resolved)
  const parsed = Object.entries(providers).flatMap(([route, value]) => {
    if (!ROUTE_PATTERN.test(route) || !isRecord(value)) return []
    const protocol = value.api
    const baseUrl = value.baseURL
    const models = modelsFromProvider(value)
    const modelIds = models.length > 0 ? models.map(model => model.id) : modelIdsFromProvider(value)
    if (!PROTOCOLS.has(protocol as CustomApiProtocol) || typeof baseUrl !== 'string' || modelIds.length === 0) return []
    return [{
      route,
      displayName: typeof value.displayName === 'string' && value.displayName.trim() ? value.displayName.trim() : route,
      baseUrl,
      protocol: protocol as CustomApiProtocol,
      modelIds,
      models,
      defaultModel,
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
  legacyProfileName?: string | null,
): Promise<CustomApiProvider[]> {
  const resolved = resolveApiTarget(target, legacyProfileName)
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
    // 表单给了完整模型定义就整段采用，否则按 modelIds 保留既有字段。
    next.models = normalized.models && normalized.models.length > 0
      ? normalized.models
      : preservedModels(previous, normalized.modelIds)
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
  legacyProfileName?: string | null,
): Promise<CustomApiProvider[]> {
  const resolved = resolveApiTarget(target, legacyProfileName)
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

/**
 * 手动把活跃 Profile 的模型配置镜像到 DSH_HOME/settings.yaml。
 *
 * 上游的做法是 Profile 与 settings.yaml 同构、双向读写；本分支里权威位置是 Profile
 * 的 `cordis.patch.yml`，所以这里只做单向镜像：Profile 的 providers 整体替换全局
 * `llm-pi-ai.providers`，`agent-default-model` 跟随 Profile（没有就删掉全局残留），
 * 其余全局键（含注释）原样保留。密钥始终只以 apiKeyEnv 引用形式存在，镜像不搬运密钥本体。
 */
export async function syncCustomApiProviders(
  target: CustomApiTarget,
  legacyProfileName?: string | null,
): Promise<CustomApiProvider[]> {
  const resolved = resolveApiTarget(target, legacyProfileName)
  const location = await resolveProviderConfigLocation(resolved)
  if (location.kind !== 'profile-patch') throw new Error('当前 Profile 没有可同步的 DSH 模型配置。')

  const providerConfig = await readEntryConfig(resolved, { id: PI_AI_ENTRY_ID, name: PI_AI_ENTRY_NAME })
  const providers = isRecord(providerConfig.providers)
    ? JSON.parse(JSON.stringify(providerConfig.providers)) as JsonRecord
    : {}
  if (Object.keys(providers).length === 0) {
    throw new Error('当前 Profile 没有可同步的 DSH Provider 配置。')
  }
  const defaultModel = await readEntryConfig(resolved, DEFAULT_MODEL_ENTRY)

  await updateLegacySettings(resolved.dshHome, document => {
    document.setIn([PI_AI_ENTRY_ID, 'providers'], document.createNode(providers))
    if (Object.keys(defaultModel).length > 0) {
      document.setIn([DEFAULT_MODEL_ENTRY.id], document.createNode(defaultModel))
    } else {
      document.deleteIn([DEFAULT_MODEL_ENTRY.id])
    }
  })
  return listCustomApiProviders(resolved)
}
