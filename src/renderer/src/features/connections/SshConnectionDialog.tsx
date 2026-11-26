/**
 * SSH 连接表单的展示与布局：运行在 renderer，包含「连接信息」与「Agent 权限」双标签页。
 * 连接数据和保存生命周期由工作区持有，不读取或回填已保存的凭据。
 */
import {
  Alert,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Switch,
  Tabs,
  type FormInstance,
} from 'antd'
import { Server } from 'lucide-react'
import type {
  SaveSshProfile,
  SshAgentAccess,
  SshProfile,
} from '../../../../../packages/connections/ssh/types.d.ts'
import { SshAgentAccessTab } from './SshAgentAccessTab.tsx'

/** SSH 连接弹窗参数契约。 */
export interface SshConnectionDialogProps {
  editing: SshProfile | 'new' | null
  busy: boolean
  error: string | null
  form: FormInstance<SaveSshProfile>
  formTab: string
  agentAccess: SshAgentAccess
  projects: readonly { id: string; name: string }[]
  onTabChange(tab: string): void
  onAgentAccessChange(next: SshAgentAccess): void
  onSave(): void
  onCancel(): void
}

function credentialStatus(profile: SshProfile): string {
  if (!profile.credentialConfigured) return '尚未配置凭据'
  return profile.auth === 'key' ? '私钥已保存' : '密码已保存'
}

function ConnectionFieldsTab({
  editing,
  auth,
  projects,
}: {
  editing: SshProfile | 'new' | null
  auth: SaveSshProfile['auth'] | undefined
  projects: readonly { id: string; name: string }[]
}) {
  const isNew = editing === 'new'
  return (
    <div className="ssh-connection-form__sections">
      <fieldset className="ssh-connection-form__section">
        <legend>连接信息</legend>
        <div className="ssh-connection-form__grid">
          <Form.Item
            name="name"
            label="连接名称"
            rules={[{ required: true, message: '请输入连接名称' }]}
          >
            <Input maxLength={100} placeholder="例如：测试服务器" />
          </Form.Item>
          <Form.Item name="environment" label="环境标签">
            <Input maxLength={40} placeholder="例如：测试、生产" />
          </Form.Item>
          <div className="ssh-connection-form__target ssh-connection-form__wide">
            <Form.Item
              name="host"
              label="服务器地址"
              rules={[{ required: true, message: '请输入服务器地址' }]}
            >
              <Input maxLength={253} placeholder="主机名或 IP 地址" />
            </Form.Item>
            <Form.Item name="port" label="端口" rules={[{ required: true }]}>
              <InputNumber min={1} max={65535} />
            </Form.Item>
          </div>
        </div>
      </fieldset>
      <fieldset className="ssh-connection-form__section">
        <legend>登录认证</legend>
        <div className="ssh-connection-form__grid">
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input maxLength={128} autoComplete="off" />
          </Form.Item>
          <Form.Item name="auth" label="认证方式">
            <Select
              options={[
                { value: 'password', label: '密码' },
                { value: 'key', label: '私钥' },
              ]}
            />
          </Form.Item>
          {auth === 'password' ? (
            <Form.Item
              className="ssh-connection-form__wide"
              name="password"
              label={isNew ? '密码' : '新密码（留空保留原密码）'}
              rules={isNew ? [{ required: true, message: '请输入密码' }] : []}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          ) : (
            <Form.Item
              className="ssh-connection-form__wide"
              name="passphrase"
              label="私钥口令（未加密的私钥可留空）"
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          )}
        </div>
      </fieldset>
      <fieldset className="ssh-connection-form__section">
        <legend>其他设置</legend>
        <div className="ssh-connection-form__grid">
          <Form.Item name="projectId" label="关联项目">
            <Select
              allowClear
              placeholder="不关联项目"
              options={projects.map(project => ({
                value: project.id,
                label: project.name,
              }))}
            />
          </Form.Item>
          <Form.Item name="disabled" label="禁用连接" valuePropName="checked">
            <Switch />
          </Form.Item>
        </div>
        {editing && editing !== 'new' && (
          <details className="ssh-connection-form__identity">
            <summary>查看主机指纹与凭据状态</summary>
            <code className="connections-fingerprint">
              {editing.fingerprint ?? '首次连接时确认主机指纹'}
            </code>
            <p>{credentialStatus(editing)}</p>
          </details>
        )}
      </fieldset>
    </div>
  )
}

/** 展示新增或编辑表单；不会读取或回填已保存的凭据。 */
export function SshConnectionDialog(props: SshConnectionDialogProps) {
  const auth = Form.useWatch('auth', props.form)
  const isNew = props.editing === 'new'
  const fingerprint = props.editing && props.editing !== 'new' ? props.editing.fingerprint : null
  return (
    <Modal
      open={props.editing !== null}
      title={
        <div className="ssh-dialog-title">
          <span className="ssh-dialog-title__icon" aria-hidden="true">
            <Server size={19} />
          </span>
          <strong>{isNew ? '新增 SSH 连接' : '编辑 SSH 连接'}</strong>
        </div>
      }
      width={620}
      centered
      className="ssh-connection-modal"
      classNames={{
        container: 'ssh-connection-modal__container',
        header: 'ssh-connection-modal__header',
        body: 'ssh-connection-modal__body',
        footer: 'ssh-connection-modal__footer',
      }}
      okText={isNew && auth === 'key' ? '保存并选择私钥' : '保存连接'}
      cancelText="取消"
      confirmLoading={props.busy}
      onOk={props.onSave}
      onCancel={props.onCancel}
      destroyOnHidden
    >
      {props.error && <Alert type="error" showIcon title="连接未保存" description={props.error} />}
      <Form form={props.form} layout="vertical" preserve={false} className="ssh-connection-form">
        <Tabs
          className="ssh-connection-form__tabs"
          activeKey={props.formTab}
          onChange={props.onTabChange}
          destroyOnHidden={false}
          items={[
            {
              key: 'connection',
              label: '连接信息',
              forceRender: true,
              children: (
                <ConnectionFieldsTab
                  editing={props.editing}
                  auth={auth}
                  projects={props.projects}
                />
              ),
            },
            {
              key: 'agentAccess',
              label: 'Agent 权限',
              forceRender: true,
              children: (
                <SshAgentAccessTab
                  value={props.agentAccess}
                  fingerprint={fingerprint}
                  onChange={props.onAgentAccessChange}
                />
              ),
            },
          ]}
        />
      </Form>
    </Modal>
  )
}
