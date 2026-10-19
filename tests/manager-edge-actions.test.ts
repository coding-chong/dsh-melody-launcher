import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
const app = read('src/App.tsx')
const cssText = read('src/styles.css')
const css = postcss.parse(cssText)

/** 取某个选择器最后一次声明的属性值（重复定义时后者覆盖前者）。 */
function decl(selector: string, property: string): string | undefined {
  let value: string | undefined
  css.walkRules(rule => {
    if (rule.selector !== selector) return
    rule.walkDecls(property, node => { value = node.value })
  })
  return value
}

// 右下角两枚图标按钮曾同时踩到三个坑：被运行与日志抽屉盖住、没有可读提示、
// 点击后没有任何反馈。这些契约防止它们再次退化。
describe('manager edge actions', () => {
  it('stacks above the runtime drawer instead of being covered by it', () => {
    const edgeZ = Number(decl('.manager-edge-actions', 'z-index'))
    const backZ = Number(decl('.manager-back', 'z-index'))
    const drawerZ = Number(decl('.runtime-drawer', 'z-index'))
    expect(edgeZ).toBeGreaterThan(drawerZ)
    expect(backZ).toBeGreaterThan(drawerZ)
  })

  it('keeps both buttons off the window corner', () => {
    expect(decl('.manager-edge-actions', 'right')).toBe('10px')
    expect(decl('.manager-edge-actions', 'bottom')).toBe('10px')
    expect(decl('.manager-back', 'right')).toBe('10px')
    expect(decl('.manager-back', 'bottom')).toBe('10px')
  })

  it('labels both icon-only buttons with a visible hint bubble', () => {
    expect(app).toContain("data-hint={copilotOpen ? '收起 DSH Copilot' : '打开 DSH Copilot'}")
    expect(app).toContain('data-hint="返回启动页"')
    expect(cssText).toContain('.manager-edge-actions [data-hint]::after')
    expect(cssText).toContain('.manager-back[data-hint]:hover::after')
  })

  it('gives the back button a larger hit area without clipping the bubble', () => {
    expect(decl('.manager-back', 'overflow')).toBe('visible')
    expect(cssText).toContain('.manager-back::before')
    expect(decl('.manager-back::before', 'inset')).toBe('-8px')
  })

  it('confirms both actions with a toast', () => {
    expect(app).toContain('已打开 DSH Copilot 面板。')
    expect(app).toContain('已收起 DSH Copilot 面板。')
    expect(app).toContain('已返回启动页。')
  })

  it('gives an opaque backdrop so the toggle stays readable over dark logs', () => {
    const rule = cssText.slice(cssText.indexOf('.manager-edge-actions .copilot-toggle,'))
    expect(rule).toContain('color-mix(in srgb, var(--surface) 94%, transparent)')
  })

  it('keeps compact log text clear of the floating buttons', () => {
    expect(decl('.runtime-compact-log', 'padding')).toContain('46px')
  })
})
