/**
 * Copy one already-installed plugin body into the shared offline pool.
 *
 * Repairing a Profile reuses whatever a sibling Profile already has on disk.
 * Such a body normally lives under `profiles/<name>/node_modules/<pkg>`, so a
 * filter that looks at the absolute path sees `node_modules` in the source
 * root and rejects the whole copy — leaving a `file:` reference to a directory
 * that was never created. Compare against the source root instead.
 *
 * The comparison must survive the two spellings of the same directory that
 * Windows hands out: the 8.3 short form (`RUNNER~1`) and the long form
 * (`runneradmin`). `os.tmpdir()` can yield the short form while `fs.cp` reports
 * the long form, and then `path.relative` sees the whole absolute path as
 * "outside the root" — the root is rejected and nothing is copied. Canonicalize
 * both sides before deciding.
 * @module electron/plugin-body-copy
 */
import { realpathSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import path from 'node:path'

/** Long/spelling-normalized form of a path, or the input when it cannot be resolved. */
function canonicalPath(target: string): string {
  try {
    return path.resolve(realpathSync.native(target))
  } catch {
    return path.resolve(target)
  }
}

/** True when `candidate` is `root` itself or lives underneath it. */
function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** fs.cp filter that keeps the source root and skips its nested node_modules. */
export function pluginBodyCopyFilter(sourceRoot: string): (source: string) => boolean {
  const givenRoot = path.resolve(sourceRoot)
  const canonicalRoot = canonicalPath(sourceRoot)
  const roots = givenRoot === canonicalRoot ? [givenRoot] : [givenRoot, canonicalRoot]
  return source => {
    let resolved = path.resolve(source)
    let root = roots.find(candidate => isWithin(candidate, resolved))
    if (root === undefined) {
      // The entry was spelled in the other form than the root; retry canonically.
      resolved = canonicalPath(source)
      root = roots.find(candidate => isWithin(candidate, resolved))
    }
    // A path the root cannot be related to at all is kept rather than dropped:
    // failing the copy is worse than copying a link layer pnpm rebuilds anyway.
    if (root === undefined) return true
    if (root === resolved) return true
    return !path.relative(root, resolved).split(path.sep).includes('node_modules')
  }
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
