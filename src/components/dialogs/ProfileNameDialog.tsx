import { Copy, PackagePlus, X } from 'lucide-react'
import { useState } from 'react'

/**
 * 新建 / 克隆 Profile 的名称输入对话框。
 *
 * 这里刻意不使用 `window.prompt`：Electron 的 renderer 不支持 prompt()，调用会
 * 直接抛错，于是「新建 Profile」「克隆」两个按钮点了完全没有反应。应用内对话框
 * 是这两个动作唯一可靠的入口。
 */

export interface ProfileNameDialogProps {
  mode: 'create' | 'clone'
  /** 克隆来源 Profile 名；mode === 'clone' 时必填。 */
  source?: string
  busy?: boolean
  onSubmit: (name: string) => void
  onClose: () => void
}

/**
 * 与主进程 isSafeProfileName 保持同一规则，只做即时提示；最终校验仍在主进程。
 * 名称会直接成为 DSH_HOME/profiles 下的目录名，所以点号结尾与 node_modules 也不收。
 */
export function validProfileName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name) && name.replace(/\.+$/, '').toLowerCase() !== 'node_modules'
}

export function ProfileNameDialog({ mode, source, busy = false, onSubmit, onClose }: ProfileNameDialogProps) {
  const [name, setName] = useState(mode === 'clone' && source ? `${source}-copy` : '')
  const trimmed = name.trim()
  const invalid = trimmed !== '' && !validProfileName(trimmed)
  const canSubmit = trimmed !== '' && !invalid && !busy
  const title = mode === 'clone' ? `克隆 Profile「${source}」` : '新建 Profile'
  const hint = invalid
    ? '名称必须以字母或数字开头，只能包含字母、数字、点、横线或下划线，最长 64 个字符。'
    : mode === 'clone'
      ? '来源 Profile 的全部文件都会被复制；两者此后的切换与运行互不影响。'
      : '名称会直接成为 DSH_HOME/profiles 下的目录名，创建后不会自动切换过去。'

  const submit = () => {
    if (!canSubmit) return
    onSubmit(trimmed)
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) onClose() }}>
      <section className="modal profile-name-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-name-title">
        <header>
          <div>{mode === 'clone' ? <Copy size={19} /> : <PackagePlus size={19} />}<h2 id="profile-name-title">{title}</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </header>
        <div className="modal-content">
          <div className="form-section">
            <label className="form-field">
              <span>Profile 名称</span>
              <input
                id="profile-name-input"
                autoFocus
                value={name}
                placeholder="例如 my-environment"
                aria-invalid={invalid}
                onChange={event => setName(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') submit()
                  if (event.key === 'Escape') onClose()
                }}
              />
            </label>
            <p style={{ color: invalid ? 'var(--danger)' : undefined }}>{hint}</p>
          </div>
        </div>
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="button" className="primary-command" disabled={!canSubmit} onClick={submit}>
            {mode === 'clone' ? <Copy size={16} /> : <PackagePlus size={16} />}
            {mode === 'clone' ? '开始克隆' : '创建'}
          </button>
        </footer>
      </section>
    </div>
  )
}
