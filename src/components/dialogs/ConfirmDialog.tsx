import { Trash2 } from 'lucide-react'
import type { ManagedPlugin } from '../../types'

/** How far an uninstall should reach. */
export type UninstallMode = 'profile' | 'purge'

/**
 * 卸载插件前的确认。
 *
 * 两种语义要分清楚：只把这个插件从当前 Profile 摘掉（其他 Profile 还在用它的
 * 话照常工作），还是从本机所有 Profile 彻底清除并回收共享 pnpm 缓存。
 */
export function ConfirmDialog({ plugin, onCancel, onConfirm }: {
  plugin: ManagedPlugin
  onCancel: () => void
  onConfirm: (mode: UninstallMode) => void
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className="confirm-icon"><Trash2 size={22} /></div>
        <h2 id="confirm-title">要卸载 {plugin.displayName} 吗？</h2>
        <p><strong>仅从当前 Profile 移除</strong>：只解除这个 Profile 的依赖与激活引用，插件本体留在共享池里，其他 Profile 继续可用，随时能再装回来。</p>
        <p><strong>彻底清除</strong>：从本机所有 DSH Profile、共享插件本体和安装记录中移除，并清理不再被引用的 GitHub 源码快照、Release 安装包及启动器受控 pnpm store 缓存（也会一并清理其他已卸载插件的残留缓存）。远程仓库、仍被其他插件共用的缓存和 DSH 本体不会被删除。</p>
        <footer>
          <button type="button" className="secondary-button" onClick={onCancel}>取消</button>
          <button type="button" className="secondary-button" onClick={() => onConfirm('profile')}>仅从当前 Profile 移除</button>
          <button type="button" className="danger-button" onClick={() => onConfirm('purge')}><Trash2 size={16} />彻底清除</button>
        </footer>
      </section>
    </div>
  )
}
