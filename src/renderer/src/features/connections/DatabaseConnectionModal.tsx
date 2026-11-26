/** 数据库连接新增与编辑弹窗：支持 MySQL、MariaDB、PostgreSQL 与 SQLite 参数切换、文件选择和权限配置。 */
import { Alert, Button, Form, Input, InputNumber, Modal, Select, Switch, Tabs } from 'antd'
import type { FormInstance } from 'antd'
import { FolderOpen } from 'lucide-react'
import type {
  DatabaseAgentAccess,
  DatabaseEngine,
  DatabaseProfile,
  SaveDatabaseProfile,
} from '../../../../../packages/connections/database/types.d.ts'
import type { SshProfile } from '../../../../../packages/connections/ssh/types.d.ts'
import { callRemote } from '../../plugins/sdk.ts'
import { DatabaseAgentAccessTab } from './DatabaseAgentAccessTab.tsx'
import { DATABASE_ENGINE_OPTIONS, engineMeta, sqliteFileName } from './database-engine-meta.ts'
import { DatabaseEngineIcon } from './DatabaseEngineIcon.tsx'

/** 数据库连接表单弹窗参数契约。 */
export interface DatabaseConnectionModalProps {
  editing: DatabaseProfile | 'new' | null
  saving: boolean
  error: string | null
  form: FormInstance<SaveDatabaseProfile>
  formTab: string
  agentAccess: DatabaseAgentAccess
  ssh: readonly SshProfile[]
  projects: readonly { id: string; name: string }[]
  availableSchemas: readonly string[]
  availableTables: Readonly<Record<string, readonly { name: string }[]>>
  onTabChange(tab: string): void
  onAgentAccessChange(next: DatabaseAgentAccess): void
  onSave(): void
  onCancel(): void
  onReportError(cause: unknown): void
}

function sshOptionLabel(item: SshProfile): string {
  if (!item.fingerprint) return `${item.name} · 尚未确认指纹`
  if (item.disabled) return `${item.name} · 已禁用`
  return item.name
}

function SqlitePathInput({
  id,
  value,
  disabled,
  onChange,
  onPick,
}: {
  id?: string
  value?: string
  disabled: boolean
  onChange?: (next: string) => void
  onPick(): void
}) {
  return (
    <div className="database-sqlite-path-row">
      <Input
        id={id}
        value={value ?? ''}
        maxLength={4096}
        placeholder="/path/to/database.db"
        aria-label="SQLite 数据库文件路径"
        onChange={event => onChange?.(event.target.value)}
      />
      <Button icon={<FolderOpen size={14} />} disabled={disabled} onClick={onPick}>
        选择文件
      </Button>
    </div>
  )
}

function EngineSelectorSection({
  engine,
  isNew,
  saving,
  onSelect,
}: {
  engine: DatabaseEngine
  isNew: boolean
  saving: boolean
  onSelect(next: DatabaseEngine): void
}) {
  return (
    <div className="database-engine-section">
      <div className="database-engine-section__head">
        <span>数据库类型</span>
        {!isNew && <small>已保存连接不可切换引擎</small>}
      </div>
      <div className="database-engine-picker" role="group" aria-label="数据库类型">
        {DATABASE_ENGINE_OPTIONS.map(option => (
          <button
            key={option.engine}
            type="button"
            className="database-engine-option"
            data-engine={option.engine}
            aria-pressed={engine === option.engine}
            disabled={!isNew || saving}
            onClick={() => onSelect(option.engine)}
          >
            <span className="database-engine-option__head">
              <DatabaseEngineIcon engine={option.engine} size={16} />
              <strong>{option.label}</strong>
            </span>
            <span>{option.summaryHint}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function NetworkTargetFields({
  engine,
  editing,
}: {
  engine: DatabaseEngine
  editing: DatabaseProfile | 'new' | null
}) {
  const meta = engineMeta(engine)
  const needsPassword =
    editing === 'new' || (editing !== null && editing.credentialConfigured === false)
  return (
    <>
      <div className="connections-form__target">
        <Form.Item
          name="host"
          label="数据库地址"
          rules={[{ required: true, whitespace: true, message: '请输入数据库地址' }]}
        >
          <Input maxLength={253} placeholder={meta.hostPlaceholder} />
        </Form.Item>
        <Form.Item name="port" label="端口" rules={[{ required: true }]}>
          <InputNumber min={1} max={65535} />
        </Form.Item>
      </div>
      <Form.Item
        name="username"
        label="用户名"
        rules={[{ required: true, whitespace: true, message: '请输入用户名' }]}
      >
        <Input maxLength={128} autoComplete="off" />
      </Form.Item>
      <Form.Item
        name="password"
        label={needsPassword ? '密码' : '新密码（留空保留原密码）'}
        rules={needsPassword ? [{ required: true, message: '请输入密码' }] : []}
      >
        <Input.Password autoComplete="new-password" />
      </Form.Item>
      <Form.Item name="database" label={meta.databaseLabel}>
        <Input maxLength={128} placeholder={meta.databasePlaceholder} />
      </Form.Item>
    </>
  )
}

function TlsTabContent({ tlsEnabled }: { tlsEnabled: boolean | undefined }) {
  return (
    <>
      <Form.Item name="tlsEnabled" label="使用 SSL/TLS" valuePropName="checked">
        <Switch />
      </Form.Item>
      {tlsEnabled && (
        <>
          <Form.Item
            name="tlsServerName"
            label="服务器身份（可选）"
            preserve
            extra="留空验证数据库地址；通过 SSH 或地址别名连接时，可填写证书中的 DNS 名称或 IP。"
          >
            <Input maxLength={253} placeholder="默认使用数据库地址" />
          </Form.Item>
          <Form.Item
            name="tlsCa"
            label="CA 证书（可选）"
            preserve
            extra="留空使用系统信任的证书颁发机构。"
          >
            <Input.TextArea
              rows={4}
              maxLength={256 * 1024}
              placeholder="-----BEGIN CERTIFICATE-----"
              spellCheck={false}
            />
          </Form.Item>
        </>
      )}
    </>
  )
}

function buildModalTabs(input: {
  props: DatabaseConnectionModalProps
  engine: DatabaseEngine
  tlsEnabled: boolean | undefined
  onSelectEngine(next: DatabaseEngine): void
  onPickSqlite(): void
}) {
  const { props, engine, tlsEnabled, onSelectEngine, onPickSqlite } = input
  const isNew = props.editing === 'new'
  const isSqlite = engine === 'sqlite'
  return [
    {
      key: 'connection',
      label: '连接信息',
      forceRender: true,
      children: (
        <>
          <EngineSelectorSection
            engine={engine}
            isNew={isNew}
            saving={props.saving}
            onSelect={onSelectEngine}
          />
          <Form.Item
            name="name"
            label="连接名称"
            rules={[{ required: true, whitespace: true, message: '请输入连接名称' }]}
          >
            <Input maxLength={100} placeholder="例如：业务只读库" />
          </Form.Item>
          {isSqlite ? (
            <Form.Item
              name="filePath"
              label="SQLite 数据库文件"
              rules={[
                { required: true, whitespace: true, message: '请选择或输入 SQLite 本地文件路径' },
              ]}
              extra="桌面工作区默认只读查询；Agent 变更前仍会弹窗确认。不可选择 MyDSH 内部数据目录或 -wal/-shm/-journal 临时文件。"
            >
              <SqlitePathInput disabled={props.saving} onPick={onPickSqlite} />
            </Form.Item>
          ) : (
            <NetworkTargetFields engine={engine} editing={props.editing} />
          )}
        </>
      ),
    },
    ...(!isSqlite
      ? [
          {
            key: 'tls',
            label: 'TLS/SSL',
            forceRender: true,
            children: <TlsTabContent tlsEnabled={tlsEnabled} />,
          },
          {
            key: 'ssh',
            label: 'SSH 通道',
            forceRender: true,
            children: (
              <Form.Item
                name="sshConnectionId"
                label="SSH 通道（可选）"
                extra="先在左侧“SSH”中保存连接并确认主机指纹。"
              >
                <Select
                  allowClear
                  placeholder="直接连接数据库"
                  options={props.ssh.map(item => ({
                    value: item.id,
                    label: sshOptionLabel(item),
                    disabled: item.disabled || !item.fingerprint,
                  }))}
                />
              </Form.Item>
            ),
          },
        ]
      : []),
    {
      key: 'agentAccess',
      label: 'Agent 权限',
      forceRender: true,
      children: (
        <DatabaseAgentAccessTab
          value={props.agentAccess}
          onChange={props.onAgentAccessChange}
          engine={engine}
          availableSchemas={props.availableSchemas}
          availableTables={props.availableTables}
          defaultDatabase={props.editing !== 'new' && props.editing ? props.editing.database : null}
        />
      ),
    },
    {
      key: 'advanced',
      label: '高级',
      forceRender: true,
      children: (
        <>
          <Form.Item name="environment" label="环境标签">
            <Input maxLength={40} placeholder="例如：测试、生产" />
          </Form.Item>
          <Form.Item name="projectId" label="关联项目">
            <Select
              allowClear
              placeholder="不关联项目"
              options={props.projects.map(project => ({
                value: project.id,
                label: project.name,
              }))}
            />
          </Form.Item>
          <Form.Item name="disabled" label="禁用连接" valuePropName="checked">
            <Switch />
          </Form.Item>
        </>
      ),
    },
  ]
}

/** 渲染支持 MySQL、MariaDB、PostgreSQL 与 SQLite 的连接创建/编辑模态框。 */
export function DatabaseConnectionModal(props: DatabaseConnectionModalProps) {
  const { editing, saving, error, form, formTab } = props
  const watchedEngine = Form.useWatch('engine', form)
  const tlsEnabled = Form.useWatch('tlsEnabled', form)
  const existingEngine = editing && editing !== 'new' ? editing.engine : 'mysql'
  const engine: DatabaseEngine = watchedEngine ?? existingEngine
  const isNew = editing === 'new'

  const selectEngine = (next: DatabaseEngine) => {
    if (!isNew || next === engine) return
    form.setFieldValue('engine', next)
    if (next === 'sqlite') {
      form.setFieldsValue({ port: 0, tlsEnabled: false, sshConnectionId: null, database: null })
      if (formTab === 'tls' || formTab === 'ssh') props.onTabChange('connection')
      return
    }
    const previousDefault = engineMeta(engine).defaultPort
    const nextDefault = engineMeta(next).defaultPort
    const currentPort = form.getFieldValue('port')
    if (
      currentPort === undefined ||
      currentPort === null ||
      currentPort === 0 ||
      currentPort === previousDefault
    ) {
      form.setFieldValue('port', nextDefault)
    }
  }

  const pickSqliteFile = () => {
    void (async () => {
      try {
        const picked = await callRemote('mydshDatabase/pickSqliteFile', {})
        if (typeof picked !== 'string' || !picked) return
        form.setFieldValue('filePath', picked)
        const currentName = form.getFieldValue('name')
        if (typeof currentName !== 'string' || !currentName.trim()) {
          form.setFieldValue('name', sqliteFileName(picked))
        }
      } catch (cause) {
        props.onReportError(cause)
      }
    })()
  }

  return (
    <Modal
      open={editing !== null}
      title={isNew ? '新增数据库连接' : '编辑数据库连接'}
      okText="保存连接"
      cancelText="取消"
      confirmLoading={saving}
      destroyOnHidden
      centered
      classNames={{
        container: 'database-connection-modal-container',
        body: 'database-connection-modal-body',
      }}
      onOk={props.onSave}
      onCancel={props.onCancel}
    >
      {error && <Alert type="error" showIcon title={error} />}
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        className="connections-form database-connection-form"
      >
        <Form.Item name="engine" hidden>
          <Input />
        </Form.Item>
        <Tabs
          activeKey={formTab}
          onChange={props.onTabChange}
          destroyOnHidden={false}
          items={buildModalTabs({
            props,
            engine,
            tlsEnabled,
            onSelectEngine: selectEngine,
            onPickSqlite: pickSqliteFile,
          })}
        />
      </Form>
    </Modal>
  )
}
