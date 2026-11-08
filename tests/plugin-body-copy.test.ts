import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyPluginBody, pluginBodyCopyFilter } from '../electron/plugin-body-copy'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-body-copy-'))
  roots.push(root)
  return root
}

/** A source body shaped like a real sibling Profile install. */
async function seedInstalledBody(root: string): Promise<string> {
  const source = path.join(root, 'profiles', 'web', 'node_modules', '@scope', 'pkg')
  await mkdir(path.join(source, 'lib'), { recursive: true })
  await mkdir(path.join(source, 'node_modules', 'dep'), { recursive: true })
  await writeFile(path.join(source, 'package.json'), '{"name":"@scope/pkg","version":"1.0.0"}\n')
  await writeFile(path.join(source, 'lib', 'index.js'), 'export default 1\n')
  await writeFile(path.join(source, 'node_modules', 'dep', 'package.json'), '{"name":"dep"}\n')
  return source
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('pluginBodyCopyFilter', () => {
  it('keeps the source root even though its path contains a node_modules segment', () => {
    const sourceRoot = path.join('C:', 'home', 'profiles', 'web', 'node_modules', '@scope', 'pkg')
    const filter = pluginBodyCopyFilter(sourceRoot)
    expect(filter(sourceRoot)).toBe(true)
    expect(filter(path.join(sourceRoot, 'lib'))).toBe(true)
    expect(filter(path.join(sourceRoot, 'package.json'))).toBe(true)
  })

  it('skips node_modules nested inside the source root', () => {
    const sourceRoot = path.join('C:', 'home', 'profiles', 'web', 'node_modules', '@scope', 'pkg')
    const filter = pluginBodyCopyFilter(sourceRoot)
    expect(filter(path.join(sourceRoot, 'node_modules'))).toBe(false)
    expect(filter(path.join(sourceRoot, 'node_modules', 'dep'))).toBe(false)
    expect(filter(path.join(sourceRoot, 'lib', 'node_modules', 'x'))).toBe(false)
  })
})

describe('copyPluginBody', () => {
  it('copies the body out of a profiles/<name>/node_modules source', async () => {
    const root = await makeRoot()
    const source = await seedInstalledBody(root)
    const target = path.join(root, 'bodies', '@scope', 'pkg', '1.0.0')

    await copyPluginBody(source, target)

    // The regression this guards: a filter comparing the absolute path rejects
    // the source root, so the destination is never created at all.
    await expect(stat(target)).resolves.toBeDefined()
    expect(await readFile(path.join(target, 'package.json'), 'utf8')).toContain('@scope/pkg')
    expect(await readFile(path.join(target, 'lib', 'index.js'), 'utf8')).toContain('export default 1')
  })

  it('omits the node_modules link layer that pnpm rebuilds in the target Profile', async () => {
    const root = await makeRoot()
    const source = await seedInstalledBody(root)
    const target = path.join(root, 'bodies', '@scope', 'pkg', '1.0.0')

    await copyPluginBody(source, target)

    await expect(stat(path.join(target, 'node_modules'))).rejects.toThrow()
  })
})
