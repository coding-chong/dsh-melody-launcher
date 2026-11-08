import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 生产环境用 `loadFile(dist/index.html)` 加载界面，文档 URL 是
 * `file:///…/dist/index.html`。此时 `/x.png` 会解析成盘符根 `file:///x.png`，
 * public/ 里的资源全部 404 —— 打包后只剩破图，dev 下却完全正常，所以必须靠
 * 静态断言把这条约束钉住。
 */
const ROOT = process.cwd()
const PUBLIC_ASSETS = ['launcher-logo.png', 'launcher-background0.png', 'launcher-icon.png']
const SCANNED_FILES = ['src/wheelchair/WheelchairHome.tsx', 'src/styles.css']

describe('public asset references', () => {
  it('从不给 public/ 资源写绝对路径', async () => {
    for (const file of SCANNED_FILES) {
      const text = await readFile(path.join(ROOT, file), 'utf8')
      for (const asset of PUBLIC_ASSETS) {
        expect(text.includes(`"/${asset}"`), `${file} 里出现了绝对的 /${asset}`).toBe(false)
        expect(text.includes(`'/${asset}'`), `${file} 里出现了绝对的 /${asset}`).toBe(false)
        expect(text.includes(`url(/${asset})`), `${file} 里出现了绝对的 url(/${asset})`).toBe(false)
      }
    }
  })

  it('背景兜底图比 CSS 所在目录高一级', async () => {
    // public/ 的图落在 dist 根，而打包后的 CSS 在 dist/assets/ 下。
    const css = await readFile(path.join(ROOT, 'src/styles.css'), 'utf8')
    expect(css).toContain(`url('../${PUBLIC_ASSETS[1]}')`)
  })
})
