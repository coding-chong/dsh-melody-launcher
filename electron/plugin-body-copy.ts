/**
 * Copy one already-installed plugin body into the shared offline pool.
 *
 * Repairing a Profile reuses whatever a sibling Profile already has on disk.
 * Such a body normally lives under `profiles/<name>/node_modules/<pkg>`, so a
 * filter that looks at the absolute path sees `node_modules` in the source
 * root and rejects the whole copy — leaving a `file:` reference to a directory
 * that was never created. Compare against the source root instead.
 * @module electron/plugin-body-copy
 */
import { cp } from 'node:fs/promises'
import path from 'node:path'

/** fs.cp filter that keeps the source root and skips its nested node_modules. */
export function pluginBodyCopyFilter(sourceRoot: string): (source: string) => boolean {
  return source => !path.relative(sourceRoot, source).split(path.sep).includes('node_modules')
}

/**
 * Copy a plugin body into the shared pool without its node_modules; pnpm
 * rebuilds that link layer inside the target Profile.
 * @param sourceRoot - installed package directory.
 * @param targetRoot - destination directory in the shared pool.
 */
export async function copyPluginBody(sourceRoot: string, targetRoot: string): Promise<void> {
  await cp(sourceRoot, targetRoot, { recursive: true, filter: pluginBodyCopyFilter(sourceRoot) })
}
