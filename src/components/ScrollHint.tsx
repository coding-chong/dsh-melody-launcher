import { ChevronDown, ChevronUp } from 'lucide-react'

/**
 * 滚轮翻页提示。
 *
 * 两套界面之间是纯滚轮手势切换：启动界面下滚进 DML 模式，DML 主菜单上滚回原版。
 * 界面上没有任何按钮或菜单对应这个动作，不加提示用户既发现不了，也回不去——所以
 * 两个 surface 各给一行淡色说明，不抢视觉但始终可见。
 */
export function ScrollHint({ direction, label }: { direction: 'up' | 'down'; label: string }) {
  const Icon = direction === 'down' ? ChevronDown : ChevronUp
  return (
    <div className="scroll-hint" role="note" aria-label={label}>
      <Icon size={14} aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}
