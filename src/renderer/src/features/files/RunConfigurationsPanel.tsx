import { CirclePlay, FileJson, Package, RefreshCw } from 'lucide-react'
import type { RunConfigurationProjection } from '../project-workspace/project-types.ts'
import { IconButton } from '../../shared/ui/IconButton.tsx'
import './files.css'

interface RunConfigurationsPanelProps {
  projection: RunConfigurationProjection | null
  loading: boolean
  error: string | null
  onRefresh(): void
}

export function RunConfigurationsPanel({
  projection,
  loading,
  error,
  onRefresh,
}: RunConfigurationsPanelProps) {
  return (
    <div className="contextual-inspector run-config-panel">
      <header>
        <div>
          <h2>运行配置</h2>
        </div>
        <IconButton label="刷新运行配置" disabled={loading} onClick={onRefresh}>
          <RefreshCw className={loading ? 'spin' : ''} size={15} />
        </IconButton>
      </header>
      <section className="run-config-source">
        <div className="section-heading">
          <FileJson size={14} />
          <strong>package.json</strong>
          <span>只读</span>
        </div>
        <p>{projection?.packageName ?? '当前项目'}的 scripts 投影。桌面端尚未接入进程执行协议。</p>
      </section>
      {error !== null && (
        <p className="contextual-panel-error" role="alert">
          {error}
        </p>
      )}
      {projection?.available ? (
        <section className="run-config-group">
          <div className="section-heading">
            <Package size={14} />
            <strong>npm</strong>
            <span>{projection.configurations.length}</span>
          </div>
          <ul>
            {projection.configurations.map(configuration => (
              <li key={configuration.id}>
                <button type="button" disabled title="执行能力尚未接入">
                  <CirclePlay size={14} aria-hidden="true" />
                  <span>
                    <strong>{configuration.name}</strong>
                    <small>{configuration.command}</small>
                  </span>
                </button>
                <code>{configuration.script}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="contextual-panel-empty">
          {projection?.message ?? (loading ? '正在读取运行配置…' : '没有可显示的运行配置。')}
        </p>
      )}
      <footer className="run-config-readonly">
        当前仅展示真实配置；运行、停止与调试尚未接入。
      </footer>
    </div>
  )
}
