import { Button, Modal, Switch } from 'antd'
import {
  ArrowLeft,
  ChevronRight,
  FolderOpen,
  GitFork,
  LoaderCircle,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Sparkles,
  TerminalSquare,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { MydshPluginInfo } from '../../../../shared/plugins.ts'
import type { SettingsPageProps } from '../../plugins/registry.ts'
import { contributionKey, PluginBoundary, usePluginSettings } from '../../plugins/react.tsx'
import { getDesktopBridge } from '../../services/desktop.ts'
import { ChatGPTSettings } from '../settings/ChatGPTSettings.tsx'
import {
  PLUGIN_CONFIGURATIONS,
  PluginConfigurationFields,
} from '../settings/PluginConfigurationFields.tsx'
import { useRuntimePlugins } from './useRuntimePlugins.ts'
import '../settings/settings.css'
import './plugins.css'

const icons = {
  shell: TerminalSquare,
  'agent-loop': Sparkles,
  subagent: GitFork,
  'web-search-deepseek': Search,
}
const CHATGPT_BUILTIN_PLUGIN = {
  key: 'builtin:chatgpt',
  title: 'ChatGPT 订阅',
  description: '连接 OpenAI 官方账号，使用 ChatGPT 订阅额度与可用模型。',
  detailDescription: '连接 ChatGPT 账号，使用订阅可用的 GPT 模型。',
} as const
const builtinSettings = new Set([
  'general',
  'appearance',
  'models',
  'presets',
  'archived-sessions',
  'automation',
])
function statusLabel(plugin: MydshPluginInfo): string {
  if (plugin.pending)
    return {
      enable: '重启后启用',
      disable: '重启后停用',
      update: '重启后更新',
      uninstall: '重启后卸载',
    }[plugin.pending.action]
  return (
    {
      active: '已启用',
      disabled: '已停用',
      waiting: '等待依赖',
      pending: '等待资源释放',
      error: '加载失败',
    }[plugin.status] ?? '状态未知'
  )
}

export function PluginManager({
  standalone = false,
  ...settings
}: SettingsPageProps & { standalone?: boolean }) {
  const runtime = useRuntimePlugins()
  const contributed = usePluginSettings().filter(item => !builtinSettings.has(item.id))
  const [selected, setSelected] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [path, setPath] = useState('')
  const [picking, setPicking] = useState(false)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<MydshPluginInfo | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'builtin' | 'user'>('all')
  const page = useRef<HTMLElement>(null)
  const previousSelection = useRef<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (selected) {
      page.current?.scrollTo?.(0, 0)
      page.current?.querySelector<HTMLElement>('.plugin-manager__back')?.focus()
    } else if (previousSelection.current)
      (
        Array.from(page.current?.querySelectorAll<HTMLElement>('[data-plugin-key]') ?? []).find(
          element => element.dataset.pluginKey === previousSelection.current,
        ) ?? page.current?.querySelector<HTMLElement>('[aria-label="搜索插件"]')
      )?.focus()
    previousSelection.current = selected
  }, [selected])
  const config = PLUGIN_CONFIGURATIONS.find(item => `config:${item.ns}` === selected)
  const isChatGPT = selected === CHATGPT_BUILTIN_PLUGIN.key
  const extension = runtime.plugins.find(item => `plugin:${item.id}` === selected)
  const customSettings = contributed.find(item => `settings:${item.id}` === selected)
  const extensions = runtime.plugins.filter(item => item.source === 'user')
  const matches = (value: string) =>
    value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  const configured = PLUGIN_CONFIGURATIONS.filter(item =>
    matches(`${item.title} ${item.description}`),
  )
  const showChatGPT = matches(
    `${CHATGPT_BUILTIN_PLUGIN.title} ${CHATGPT_BUILTIN_PLUGIN.description} ${CHATGPT_BUILTIN_PLUGIN.detailDescription}`,
  )
  const builtinTotal = PLUGIN_CONFIGURATIONS.length + 1
  const visibleExtensions = extensions.filter(item => matches(`${item.name} ${item.id}`))
  const extraSettings = contributed.filter(item => matches(item.label))
  const busy = runtime.busy !== null
  const title =
    config?.title ??
    (isChatGPT ? CHATGPT_BUILTIN_PLUGIN.title : undefined) ??
    extension?.name ??
    customSettings?.label
  const detailDescription =
    config?.description ?? (isChatGPT ? CHATGPT_BUILTIN_PLUGIN.detailDescription : undefined)
  const refresh = () => {
    void runtime.load()
    void settings.load()
  }
  const choose = async () => {
    setPicking(true)
    setPickerError(null)
    try {
      const value = await getDesktopBridge().host.call('mydshPlugins.chooseDirectory', {})
      if (mounted.current && typeof value === 'string') setPath(value)
    } catch (error) {
      if (mounted.current)
        setPickerError(error instanceof Error ? error.message : '无法选择插件文件夹')
    } finally {
      if (mounted.current) setPicking(false)
    }
  }
  const install = async () => {
    if (await runtime.operate('install', { path: path.trim() })) {
      setAdding(false)
      setPath('')
    }
  }
  return (
    <section
      ref={page}
      className={`plugin-manager${standalone ? ' plugin-manager--standalone' : ''}`}
      aria-label="插件管理页面"
    >
      <div className="plugin-manager__body">
        <header className="plugin-manager__header">
          <div>
            {selected && (
              <button
                className="plugin-manager__back"
                type="button"
                onClick={() => {
                  setSelected(null)
                }}
              >
                <ArrowLeft size={15} aria-hidden="true" />
                所有插件
              </button>
            )}
            <h2>{selected ? (title ?? '插件详情') : '插件与能力扩展'}</h2>
            {!selected && <p>安装、启用和配置内置插件与受信任的本地扩展。</p>}
            {detailDescription !== undefined && <p>{detailDescription}</p>}
          </div>
          {!selected && (
            <div className="plugin-manager__actions">
              <Button
                type="text"
                aria-label="刷新插件"
                title="刷新插件"
                disabled={busy || runtime.loading || settings.state.loading}
                icon={<RefreshCw size={16} className={runtime.loading ? 'spin' : undefined} />}
                onClick={refresh}
              />
              <Button
                icon={<Plus size={15} aria-hidden="true" />}
                disabled={busy}
                onClick={() => {
                  runtime.clearError()
                  setPickerError(null)
                  setAdding(true)
                }}
              >
                添加插件
              </Button>
            </div>
          )}
        </header>
        {!adding && !removing && runtime.error && (
          <p className="settings-inline-error" role="alert">
            {runtime.error}
          </p>
        )}
        {standalone && settings.state.error && (
          <p className="settings-inline-error" role="alert">
            {settings.state.error}
          </p>
        )}
        <span className="visually-hidden" role="status">
          {runtime.notice}
        </span>
        {config && <PluginConfigurationFields {...settings} id={config.ns} />}
        {isChatGPT && <ChatGPTSettings embedded />}
        {customSettings && (
          <PluginBoundary key={contributionKey(customSettings)} name={customSettings.label}>
            <customSettings.component {...settings} />
          </PluginBoundary>
        )}
        {extension && (
          <div className="plugin-manager__detail">
            <div className="plugin-manager__identity">
              <span className="plugin-manager__icon">
                <Puzzle size={25} />
              </span>
              <div>
                <strong>{extension.name}</strong>
                <p>
                  {extension.id} · {extension.version}
                </p>
              </div>
              <Switch
                checked={extension.enabled}
                aria-label={`启用 ${extension.name}`}
                disabled={busy || !!extension.pending}
                loading={runtime.busy === extension.id}
                onChange={enabled => {
                  void runtime.operate(enabled ? 'enable' : 'disable', { id: extension.id })
                }}
              />
            </div>
            <dl>
              <div>
                <dt>状态</dt>
                <dd>{statusLabel(extension)}</dd>
              </div>
              <div>
                <dt>版本</dt>
                <dd>{extension.version}</dd>
              </div>
              {extension.dependencies &&
                Object.entries(extension.dependencies).map(([id, version]) => (
                  <div key={id}>
                    <dt>依赖</dt>
                    <dd>
                      {id} · {version}
                    </dd>
                  </div>
                ))}
            </dl>
            {extension.error && (
              <p className="settings-inline-error" role="alert">
                {extension.error}
              </p>
            )}
            {extension.pending && (
              <p className="plugin-manager__hint">
                当前任务或未保存内容仍在使用此插件；退出并重新打开 MyDSH 后完成操作。
              </p>
            )}
            <div className="plugin-manager__actions">
              {extension.previousVersion && (
                <Button
                  disabled={busy || !!extension.pending}
                  onClick={() => {
                    void runtime.operate('rollback', { id: extension.id })
                  }}
                >
                  恢复到 {extension.previousVersion}
                </Button>
              )}
              <Button
                danger
                disabled={busy || !!extension.pending}
                onClick={() => {
                  runtime.clearError()
                  setRemoving(extension)
                }}
              >
                卸载插件
              </Button>
            </div>
          </div>
        )}
        {selected && !config && !isChatGPT && !extension && !customSettings && (
          <p className="plugin-manager__hint">此插件已移除或暂时不可用。</p>
        )}
        {!selected && (
          <>
            <div className="plugin-manager__toolbar">
              <label className="plugin-manager__search">
                <Search size={15} aria-hidden="true" />
                <input
                  type="search"
                  aria-label="搜索插件"
                  placeholder="搜索插件"
                  value={search}
                  onChange={event => {
                    setSearch(event.target.value)
                  }}
                />
              </label>
              <div className="plugin-manager__filters" aria-label="插件分类">
                {(
                  [
                    ['all', `全部 (${builtinTotal + extensions.length})`],
                    ['builtin', `内置 (${builtinTotal})`],
                    ['user', `用户扩展 (${extensions.length})`],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {filter !== 'user' && (
              <section className="plugin-manager__group" aria-label="内置插件">
                <h3>
                  内置 <span>{builtinTotal}</span>
                </h3>
                {configured.map(item => {
                  const Icon = icons[item.ns]
                  return (
                    <button
                      className="plugin-manager__row"
                      data-plugin-key={`config:${item.ns}`}
                      key={item.ns}
                      type="button"
                      aria-label={`配置 ${item.title}`}
                      onClick={() => {
                        setSelected(`config:${item.ns}`)
                      }}
                    >
                      <span className={`plugin-manager__icon plugin-manager__icon--${item.ns}`}>
                        <Icon size={25} aria-hidden="true" />
                      </span>
                      <span className="plugin-manager__copy">
                        <strong>{item.title}</strong>
                        <small>{item.description}</small>
                      </span>
                      <ChevronRight
                        size={16}
                        className="plugin-manager__chevron"
                        aria-hidden="true"
                      />
                    </button>
                  )
                })}
                {showChatGPT && (
                  <button
                    className="plugin-manager__row"
                    data-plugin-key={CHATGPT_BUILTIN_PLUGIN.key}
                    type="button"
                    aria-label={`配置 ${CHATGPT_BUILTIN_PLUGIN.title}`}
                    onClick={() => {
                      setSelected(CHATGPT_BUILTIN_PLUGIN.key)
                    }}
                  >
                    <span className="plugin-manager__icon plugin-manager__icon--chatgpt">
                      <Sparkles size={25} aria-hidden="true" />
                    </span>
                    <span className="plugin-manager__copy">
                      <strong>{CHATGPT_BUILTIN_PLUGIN.title}</strong>
                      <small>{CHATGPT_BUILTIN_PLUGIN.description}</small>
                    </span>
                    <ChevronRight
                      size={16}
                      className="plugin-manager__chevron"
                      aria-hidden="true"
                    />
                  </button>
                )}
                {configured.length === 0 && !showChatGPT && (
                  <p className="plugin-manager__hint">没有匹配的内置插件。</p>
                )}
              </section>
            )}
            {filter !== 'builtin' && (
              <section className="plugin-manager__group" aria-label="已安装插件">
                <h3>
                  已安装 <span>{extensions.length}</span>
                  {runtime.loading && (
                    <LoaderCircle className="spin" size={13} aria-label="正在读取插件" />
                  )}
                </h3>
                {visibleExtensions.map(plugin => (
                  <div
                    className="plugin-manager__row plugin-manager__row--installed"
                    key={plugin.id}
                  >
                    <button
                      className="plugin-manager__open"
                      type="button"
                      data-plugin-key={`plugin:${plugin.id}`}
                      aria-label={`查看 ${plugin.name}`}
                      onClick={() => {
                        setSelected(`plugin:${plugin.id}`)
                      }}
                    >
                      <span className="plugin-manager__icon">
                        <Puzzle size={25} aria-hidden="true" />
                      </span>
                      <span className="plugin-manager__copy">
                        <strong>{plugin.name}</strong>
                        <small>
                          {plugin.id} · {plugin.version}
                        </small>
                        {plugin.status !== 'active' && (
                          <small data-status={plugin.status}>{statusLabel(plugin)}</small>
                        )}
                        {plugin.error && <small data-status="error">{plugin.error}</small>}
                      </span>
                    </button>
                    <Switch
                      checked={plugin.enabled}
                      aria-label={`启用 ${plugin.name}`}
                      disabled={busy || !!plugin.pending}
                      loading={runtime.busy === plugin.id}
                      onChange={enabled => {
                        void runtime.operate(enabled ? 'enable' : 'disable', { id: plugin.id })
                      }}
                    />
                  </div>
                ))}
                {!runtime.loading && visibleExtensions.length === 0 && (
                  <p className="plugin-manager__hint">
                    {search
                      ? '没有匹配的已安装插件。'
                      : '尚未安装插件。点击“添加插件”安装本地 MyDSH 插件。'}
                  </p>
                )}
              </section>
            )}
            {filter !== 'builtin' && extraSettings.length > 0 && (
              <section className="plugin-manager__group" aria-label="扩展配置">
                <h3>扩展配置</h3>
                {extraSettings.map(item => (
                  <button
                    className="plugin-manager__row"
                    key={item.id}
                    type="button"
                    data-plugin-key={`settings:${item.id}`}
                    onClick={() => {
                      setSelected(`settings:${item.id}`)
                    }}
                  >
                    <span className="plugin-manager__icon">
                      <Puzzle size={25} />
                    </span>
                    <span className="plugin-manager__copy">
                      <strong>{item.label}</strong>
                      <small>由已启用的插件提供</small>
                    </span>
                    <ChevronRight size={16} />
                  </button>
                ))}
              </section>
            )}
          </>
        )}
      </div>
      <Modal
        title="添加插件"
        open={adding}
        centered
        width={520}
        destroyOnHidden
        okText="安装并启用"
        cancelText="取消"
        confirmLoading={runtime.busy === 'install'}
        okButtonProps={{ disabled: !path.trim() || picking || busy }}
        cancelButtonProps={{ disabled: busy || picking }}
        closable={!busy && !picking}
        mask={{ closable: !busy && !picking }}
        onCancel={() => {
          if (!busy && !picking) setAdding(false)
        }}
        onOk={() => {
          void install()
        }}
      >
        <div className="plugin-install">
          <p>选择包含 mydsh.plugin.json 的 MyDSH 插件文件夹。</p>
          <label htmlFor="plugin-package-path">插件文件夹</label>
          <div className="plugin-install__path">
            <input
              id="plugin-package-path"
              value={path}
              placeholder="粘贴路径或选择文件夹"
              disabled={busy || picking}
              onChange={event => {
                setPath(event.target.value)
              }}
            />
            <Button
              icon={<FolderOpen size={16} />}
              aria-label="选择插件文件夹"
              loading={picking}
              disabled={busy}
              onClick={() => {
                void choose()
              }}
            />
          </div>
          <p className="plugin-manager__hint">
            插件可以访问本机文件并执行代码，请仅安装信任的来源。DSH 插件需先适配为 MyDSH 插件。
          </p>
          {(runtime.error || pickerError) && (
            <p className="settings-inline-error" role="alert">
              {pickerError ?? runtime.error}
            </p>
          )}
        </div>
      </Modal>
      <Modal
        title={`卸载 ${removing?.name ?? '插件'}`}
        open={removing !== null}
        centered
        okText="卸载"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        confirmLoading={busy}
        cancelButtonProps={{ disabled: busy }}
        closable={!busy}
        mask={{ closable: !busy }}
        onCancel={() => {
          if (!busy) setRemoving(null)
        }}
        onOk={() => {
          if (removing)
            void runtime.operate('uninstall', { id: removing.id }).then(ok => {
              if (ok) {
                setRemoving(null)
                setSelected(null)
              }
            })
        }}
      >
        <p>将移除插件的安装文件，保留插件数据。正在使用的插件将在重新打开 MyDSH 后完成卸载。</p>
        {runtime.error && (
          <p className="settings-inline-error" role="alert">
            {runtime.error}
          </p>
        )}
      </Modal>
    </section>
  )
}
