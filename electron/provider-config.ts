import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { isSafeProfileName } from './profile'

/**
 * 模型路由（`llm-pi-ai.providers`）的权威位置随 DSH 版本移动：
 *
 * - DSH 0.2 起，配置树由 bundle 补丁与 Profile 自己的 `cordis.patch.yml`
 *   组合而成，配置界面写的是 Profile 补丁；`$DSH_HOME/settings.yaml` 已被
 *   移除，只会在启动时被一次性迁移成 `settings.yaml.imported`。
 * - 旧版 DSH 把同一段配置放在 `$DSH_HOME/settings.yaml` 的顶层命名空间。
 *
 * 启动器此前无条件写 `settings.yaml`，于是在 0.2 上写出的路由没有任何读者，
 * 界面里也看不到 Profile 已经声明的 provider。这里把两代位置收敛成一处读写口。
 */
export const PI_AI_ENTRY_ID = 'llm-pi-ai'
export const PI_AI_ENTRY_NAME = '@deepseek-ai/dsh-llm-pi-ai'

const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'
const LEGACY_SETTINGS_FILENAME = 'settings.yaml'

export type ProviderConfigKind = 'profile-patch' | 'legacy-settings'

export interface ProviderConfigTarget {
  dshHome: string
  /** 活跃 Profile 名；缺省时退回旧版 `settings.yaml`。 */
  profileName?: string | null
}

export interface ProviderConfigLocation {
  kind: ProviderConfigKind
  filePath: string
}

export interface ProviderCatalogSnapshot extends ProviderConfigLocation {
  providers: Record<string, unknown>
}

export type JsonRecord = Record<string, unknown>

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeProviderTarget(target: string | ProviderConfigTarget): ProviderConfigTarget {
  if (typeof target === 'string') return { dshHome: target }
  if (!target || typeof target.dshHome !== 'string' || !target.dshHome.trim()) {
    throw new Error('DSH 目录无效。')
  }
  return {
    dshHome: target.dshHome,
    profileName: typeof target.profileName === 'string' ? target.profileName : null,
  }
}

async function pathExistsAsDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
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

/** Profile 目录存在时，模型路由跟随该 Profile 的组合补丁；否则退回旧版兼容层。 */
export async function resolveProviderConfigLocation(
  target: string | ProviderConfigTarget,
): Promise<ProviderConfigLocation> {
  const { dshHome, profileName } = normalizeProviderTarget(target)
  const name = typeof profileName === 'string' ? profileName.trim() : ''
  // 复用 profile.ts 的严格规则。原来的宽松正则会让 `..` 拼出 dshHome 本身，把根
  // 目录的 cordis.patch.yml 当成 Profile 补丁读写；也会放过 `.` 与 node_modules。
  if (isSafeProfileName(name)) {
    const profileDirectory = path.join(dshHome, 'profiles', name)
    if (await pathExistsAsDirectory(profileDirectory)) {
      return { kind: 'profile-patch', filePath: path.join(profileDirectory, PROFILE_PATCH_FILENAME) }
    }
  }
  return { kind: 'legacy-settings', filePath: path.join(dshHome, LEGACY_SETTINGS_FILENAME) }
}

interface OpenProviderDocument {
  location: ProviderConfigLocation
  document: ReturnType<typeof parseDocument>
  /** `providers` 在文档里的路径；`null` 表示补丁里还没有 llm-pi-ai 条目。 */
  providersPath: Array<string | number> | null
  providers: JsonRecord
}

function toPlain(document: ReturnType<typeof parseDocument>, value: unknown): unknown {
  if (isMap(value) || isSeq(value)) return value.toJS(document)
  if (isScalar(value)) return value.value
  return value
}

export interface PatchEntrySelector {
  id: string
  name?: string
}

function patchEntryIndex(
  document: ReturnType<typeof parseDocument>,
  selector: PatchEntrySelector,
): number {
  const contents = document.contents
  if (!isSeq(contents)) return -1
  for (let index = 0; index < contents.items.length; index += 1) {
    const id = toPlain(document, document.getIn([index, 'id']))
    const name = toPlain(document, document.getIn([index, 'name']))
    if (id === selector.id) return index
    if (selector.name && name === selector.name) return index
  }
  return -1
}

function providerMapOf(value: unknown): JsonRecord {
  if (!isRecord(value)) return {}
  const providers = value.providers
  return isRecord(providers) ? (JSON.parse(JSON.stringify(providers)) as JsonRecord) : {}
}

async function openProviderDocument(location: ProviderConfigLocation): Promise<OpenProviderDocument> {
  const source = await readSource(location.filePath)

  if (location.kind === 'profile-patch') {
    const document = parseDocument(source ?? '[]\n', { uniqueKeys: true })
    if (document.errors.length > 0) {
      throw new Error('DSH Profile 组合补丁格式无效，请先修复 cordis.patch.yml 后重试。')
    }
    if (document.contents === null) document.contents = document.createNode([]) as never
    if (!isSeq(document.contents)) {
      throw new Error('DSH Profile 组合补丁的顶层必须是条目列表。')
    }
    const index = patchEntryIndex(document, { id: PI_AI_ENTRY_ID, name: PI_AI_ENTRY_NAME })
    if (index < 0) {
      return { location, document, providersPath: null, providers: {} }
    }
    const config = toPlain(document, document.getIn([index, 'config']))
    return {
      location,
      document,
      providersPath: [index, 'config', 'providers'],
      providers: providerMapOf(config),
    }
  }

  const document = parseDocument(source ?? '{}\n', { uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new Error('DSH settings.yaml 格式无效，请先修复配置文件后重试。')
  }
  const value = document.toJS() as unknown
  if (value !== null && !isRecord(value)) throw new Error('DSH settings.yaml 顶层必须是配置映射。')
  const namespace = isRecord(value) ? value[PI_AI_ENTRY_ID] : undefined
  return {
    location,
    document,
    providersPath: [PI_AI_ENTRY_ID, 'providers'],
    providers: providerMapOf(namespace),
  }
}

export async function readProviderCatalog(
  target: string | ProviderConfigTarget,
): Promise<ProviderCatalogSnapshot> {
  const location = await resolveProviderConfigLocation(target)
  const opened = await openProviderDocument(location)
  return { ...location, providers: opened.providers }
}

/**
 * 读取任意一条 Loader 条目的 `config`。
 *
 * 补丁按条目 id 覆盖整段 config；旧版 DSH 把同名配置放在 `settings.yaml`
 * 的顶层命名空间。解析失败按“未配置”处理，交给调用方的默认值兜底。
 */
export async function readEntryConfig(
  target: string | ProviderConfigTarget,
  selector: PatchEntrySelector,
): Promise<JsonRecord> {
  const location = await resolveProviderConfigLocation(target)
  const source = await readSource(location.filePath)
  if (source === null) return {}

  const document = parseDocument(source, { uniqueKeys: true })
  if (document.errors.length > 0) return {}

  if (location.kind === 'legacy-settings') {
    const value = document.toJS() as unknown
    const entry = isRecord(value) ? value[selector.id] : undefined
    return isRecord(entry) ? (JSON.parse(JSON.stringify(entry)) as JsonRecord) : {}
  }

  if (!isSeq(document.contents)) return {}
  const index = patchEntryIndex(document, selector)
  if (index < 0) return {}
  const config = toPlain(document, document.getIn([index, 'config']))
  return isRecord(config) ? (JSON.parse(JSON.stringify(config)) as JsonRecord) : {}
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export interface ProviderCatalogUpdate {
  location: ProviderConfigLocation
  /** 是否存在真实写入（没有变更时不动文件）。 */
  changed: boolean
}

/**
 * 读取 → 变更 → 只写回真正变化的条目。
 *
 * `mutate` 收到的是 providers 的深拷贝快照；未改动的 route 节点原样留在文档里，
 * 因此补丁中的注释、字段顺序与其它条目都不会被重排。
 */
export async function updateProviderCatalog(
  target: string | ProviderConfigTarget,
  mutate: (providers: JsonRecord) => void,
): Promise<ProviderCatalogUpdate> {
  const location = await resolveProviderConfigLocation(target)
  const opened = await openProviderDocument(location)
  const before = opened.providers
  const after = JSON.parse(JSON.stringify(before)) as JsonRecord
  mutate(after)

  const removedRoutes = Object.keys(before).filter(route => !(route in after))
  const changedRoutes = Object.keys(after).filter(route => !sameValue(before[route], after[route]))

  if (opened.providersPath === null) {
    if (Object.keys(after).length === 0) return { location, changed: false }
    opened.document.add(opened.document.createNode({
      id: PI_AI_ENTRY_ID,
      name: PI_AI_ENTRY_NAME,
      config: { providers: after },
    }))
    await writeSource(location.filePath, opened.document.toString({ lineWidth: 0 }), 0o644)
    return { location, changed: true }
  }

  if (removedRoutes.length === 0 && changedRoutes.length === 0) {
    return { location, changed: false }
  }

  const basePath = opened.providersPath
  for (const route of changedRoutes) {
    opened.document.setIn([...basePath, route], opened.document.createNode(after[route]))
  }
  for (const route of removedRoutes) {
    opened.document.deleteIn([...basePath, route])
  }

  if (Object.keys(after).length === 0) {
    // 没有路由时整段移除，避免留下 `providers: {}` 覆盖掉 DSH 的默认配置。
    opened.document.deleteIn(basePath)
    if (location.kind === 'profile-patch') {
      const configPath = basePath.slice(0, -1)
      const config = toPlain(opened.document, opened.document.getIn(configPath))
      if (isRecord(config) && Object.keys(config).length === 0) opened.document.deleteIn(configPath)
    }
  }

  const mode = location.kind === 'legacy-settings' ? 0o600 : 0o644
  await writeSource(location.filePath, opened.document.toString({ lineWidth: 0 }), mode)
  return { location, changed: true }
}
