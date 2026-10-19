import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseDocument } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listCustomApiProviders, removeCustomApiProvider, saveCustomApiProvider } from '../electron/custom-api'
import { readEntryConfig, resolveProviderConfigLocation } from '../electron/provider-config'

let temporaryHome = ''

const PROFILE_PATCH = `- id: ui-settings-general
  name: '@deepseek-ai/dsh-client-ui-settings-general'
  config:
    welcomeNoticeVersion: 2026-09-28.1
# profile-local provider declared by the DSH models page
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      commandcodedirect:
        displayName: commandcodedirect
        apiKeyEnv: COMMANDCODEDIRECT_API_KEY
        api: openai-responses
        baseURL: https://api.commandcode.ai/provider/v1
        models:
          - id: deepseek/deepseek-v4.1-flash
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
`

beforeEach(async () => {
  temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-launcher-provider-config-'))
})

afterEach(async () => {
  await rm(temporaryHome, { recursive: true, force: true })
})

async function seedProfile(patch: string | null, profileName = 'web'): Promise<string> {
  const profileDirectory = path.join(temporaryHome, 'profiles', profileName)
  await mkdir(profileDirectory, { recursive: true })
  if (patch !== null) await writeFile(path.join(profileDirectory, 'cordis.patch.yml'), patch, 'utf8')
  return profileDirectory
}

async function readPatch(profileDirectory: string): Promise<Record<string, any>[]> {
  const source = await readFile(path.join(profileDirectory, 'cordis.patch.yml'), 'utf8')
  return parseDocument(source).toJS() as Record<string, any>[]
}

function providerInput(overrides: Record<string, unknown> = {}) {
  return {
    route: 'local-gateway',
    displayName: 'Local Gateway',
    baseUrl: 'http://127.0.0.1:11434/v1',
    protocol: 'openai-completions' as const,
    modelIds: ['qwen3:8b'],
    ...overrides,
  }
}

describe('provider config location', () => {
  it('targets the active profile patch instead of the retired settings.yaml', async () => {
    const profileDirectory = await seedProfile(PROFILE_PATCH)
    const location = await resolveProviderConfigLocation({ dshHome: temporaryHome, profileName: 'web' })
    expect(location.kind).toBe('profile-patch')
    expect(location.filePath).toBe(path.join(profileDirectory, 'cordis.patch.yml'))
  })

  it('falls back to settings.yaml when the profile is unknown', async () => {
    const location = await resolveProviderConfigLocation({ dshHome: temporaryHome, profileName: 'missing' })
    expect(location.kind).toBe('legacy-settings')
    expect(location.filePath).toBe(path.join(temporaryHome, 'settings.yaml'))
  })
})

describe('custom API providers in the profile patch', () => {
  it('lists the providers the profile already declares', async () => {
    await seedProfile(PROFILE_PATCH)
    const providers = await listCustomApiProviders({ dshHome: temporaryHome, profileName: 'web' })
    expect(providers).toEqual([expect.objectContaining({
      route: 'commandcodedirect',
      displayName: 'commandcodedirect',
      protocol: 'openai-responses',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      modelIds: ['deepseek/deepseek-v4.1-flash'],
      credentialName: 'COMMANDCODEDIRECT_API_KEY',
      hasApiKey: false,
    })])
  })

  it('writes a new route next to the existing one and keeps comments and other entries', async () => {
    const profileDirectory = await seedProfile(PROFILE_PATCH)
    const providers = await saveCustomApiProvider(
      { dshHome: temporaryHome, profileName: 'web' },
      { ...providerInput(), apiKey: 'secret-value' },
    )

    const source = await readFile(path.join(profileDirectory, 'cordis.patch.yml'), 'utf8')
    const entries = await readPatch(profileDirectory)
    const llmEntry = entries.find(entry => entry.id === 'llm-pi-ai')

    expect(source).toContain('# profile-local provider declared by the DSH models page')
    expect(entries.map(entry => entry.id)).toContain('permission')
    expect(llmEntry?.config.providers.commandcodedirect.apiKeyEnv).toBe('COMMANDCODEDIRECT_API_KEY')
    expect(llmEntry?.config.providers['local-gateway']).toMatchObject({
      displayName: 'Local Gateway',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKeyEnv: 'LOCAL_GATEWAY_API_KEY',
      models: [{ id: 'qwen3:8b' }],
    })
    expect(providers.map(provider => provider.route).sort()).toEqual(['commandcodedirect', 'local-gateway'])

    const credentials = await readFile(path.join(temporaryHome, '.credentials.yaml'), 'utf8')
    expect(credentials).toContain('LOCAL_GATEWAY_API_KEY: secret-value')
    // settings.yaml 在 DSH 0.2 已退役，启动器不能再往那里写第二份真相。
    await expect(readFile(path.join(temporaryHome, 'settings.yaml'), 'utf8')).rejects.toThrow()
  })

  it('creates the llm-pi-ai entry when the profile patch has none', async () => {
    const profileDirectory = await seedProfile('- id: permission\n  name: \'@deepseek-ai/dsh-permission-presets\'\n')
    await saveCustomApiProvider(
      { dshHome: temporaryHome, profileName: 'web' },
      { ...providerInput(), apiKey: 'secret-value' },
    )
    const entries = await readPatch(profileDirectory)
    const llmEntry = entries.find(entry => entry.id === 'llm-pi-ai')
    expect(llmEntry).toMatchObject({ name: '@deepseek-ai/dsh-llm-pi-ai' })
    expect(llmEntry?.config.providers['local-gateway'].models).toEqual([{ id: 'qwen3:8b' }])
    expect(entries.map(entry => entry.id)).toContain('permission')
  })

  it('removes only the requested route and its credential', async () => {
    const profileDirectory = await seedProfile(PROFILE_PATCH)
    const target = { dshHome: temporaryHome, profileName: 'web' }
    await saveCustomApiProvider(target, { ...providerInput(), apiKey: 'secret-value' })
    const providers = await removeCustomApiProvider(target, 'local-gateway')

    const entries = await readPatch(profileDirectory)
    const llmEntry = entries.find(entry => entry.id === 'llm-pi-ai')
    expect(llmEntry?.config.providers['local-gateway']).toBeUndefined()
    expect(llmEntry?.config.providers.commandcodedirect).toBeDefined()
    expect(providers.map(provider => provider.route)).toEqual(['commandcodedirect'])
    const credentials = await readFile(path.join(temporaryHome, '.credentials.yaml'), 'utf8').catch(() => '')
    expect(credentials).not.toContain('LOCAL_GATEWAY_API_KEY')
  })

  it('drops the providers section when the last route is removed', async () => {
    const profileDirectory = await seedProfile(`- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      local-gateway:
        displayName: Local Gateway
        api: openai-completions
        baseURL: http://127.0.0.1:11434/v1
        models:
          - id: qwen3:8b
`)
    await removeCustomApiProvider({ dshHome: temporaryHome, profileName: 'web' }, 'local-gateway')
    const entries = await readPatch(profileDirectory)
    const llmEntry = entries.find(entry => entry.id === 'llm-pi-ai')
    expect(llmEntry?.config).toBeUndefined()
  })

  it('rejects a profile patch that is not an entry list', async () => {
    await seedProfile('llm-pi-ai:\n  providers: {}\n')
    await expect(listCustomApiProviders({ dshHome: temporaryHome, profileName: 'web' }))
      .rejects.toThrow('顶层必须是条目列表')
  })
})

describe('profile entry config', () => {
  it('reads agent-default-model from the profile patch', async () => {
    await seedProfile(`- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: commandcodedirect
    model: deepseek/deepseek-v4.1-flash
    reasoningEffort: high
`)
    const config = await readEntryConfig(
      { dshHome: temporaryHome, profileName: 'web' },
      { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model' },
    )
    expect(config).toEqual({
      provider: 'commandcodedirect',
      model: 'deepseek/deepseek-v4.1-flash',
      reasoningEffort: 'high',
    })
  })

  it('reads the legacy settings namespace when the profile is unknown', async () => {
    await writeFile(path.join(temporaryHome, 'settings.yaml'), 'agent-default-model:\n  provider: local\n', 'utf8')
    const config = await readEntryConfig(
      { dshHome: temporaryHome, profileName: 'missing' },
      { id: 'agent-default-model' },
    )
    expect(config).toEqual({ provider: 'local' })
  })

  it('reports an empty config for entries that are absent', async () => {
    await seedProfile(PROFILE_PATCH)
    await expect(readEntryConfig(
      { dshHome: temporaryHome, profileName: 'web' },
      { id: 'agent-default-model' },
    )).resolves.toEqual({})
  })
})
