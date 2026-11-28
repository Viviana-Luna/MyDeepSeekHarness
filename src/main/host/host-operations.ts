/**
 * 主进程公开的产品级运行核心动作白名单与固定 Remote endpoint 路由表。
 *
 * renderer 只能指定白名单内的产品动作标识，不能直接拼接或注入底层 RPC 方法名。
 */

import {
  directPayload,
  parseAgentPresetArgument,
  parseArchiveSessionArgument,
  parseCreateSessionForWorkspaceArgument,
  parseCreateWorkspaceArgument,
  parseCredentialDescribeArgument,
  parseCredentialSetArgument,
  parseCredentialUnsetArgument,
  parseEmptyArgument,
  parseExecuteSessionCommandArgument,
  parseFileReferencesArgument,
  parseForkSessionArgument,
  parseGoalArgument,
  parseMessageFeedbackDeleteArgument,
  parseMessageFeedbackListArgument,
  parseMessageFeedbackPutArgument,
  parseModernPageArgument,
  parseModernPromptArgument,
  parsePermissionCommandArgument,
  parsePluginInventoryArgument,
  parsePromptSessionArgument,
  parseRemoteCopyAgentPresetArgument,
  parseRemoteDiscoverModelsArgument,
  parseRenameSessionArgument,
  parseRenameWorkspaceArgument,
  parseReorderWorkspaceArgument,
  parseReorderWorkspaceSessionArgument,
  parseSearchSessionsArgument,
  parseSelectModelArgument,
  parseSelectSessionAgentPresetArgument,
  parseSessionAttachmentArgument,
  parseSessionCommandsArgument,
  parseSessionModelCatalogArgument,
  parseSessionSkillsArgument,
  parseSettingsMutationArgument,
  parseSubagentArgument,
  parseWorkspaceArgument,
  wrapRequestArgument,
} from './host-payload-validators.ts'

/** 允许由受信任本地 renderer 调用的产品动作白名单。 */
export const DSH_HOST_OPERATIONS = [
  'describe',
  'listSessions',
  'searchSessions',
  'listFileReferences',
  'createSession',
  'renameSession',
  'forkSession',
  'listMessageFeedback',
  'putMessageFeedback',
  'deleteMessageFeedback',
  'loadSessionPage',
  'getSessionAttachment',
  'getSessionModels',
  'selectSessionModel',
  'selectPermissionPreset',
  'listPermissionPresets',
  'listSessionCommands',
  'listSessionSkills',
  'executeSessionCommand',
  'promptSession',
  'updateSessionQueue',
  'cancelSession',
  'describeSettings',
  'openSettingsDocument',
  'mutateSettings',
  'describeCredentials',
  'setCredential',
  'unsetCredential',
  'listModelProviders',
  'listHostModels',
  'discoverProviderModels',
  'listAgentPresets',
  'selectSessionAgentPreset',
  'readAgentPreset',
  'copyAgentPreset',
  'openAgentPreset',
  'removeAgentPreset',
  'listHostPlugins',
  'archiveSession',
  'unarchiveSession',
  'deleteArchivedSession',
  'listWorkspaces',
  'pickWorkspaceDirectory',
  'createWorkspace',
  'renameWorkspace',
  'removeWorkspace',
  'reorderWorkspace',
  'reorderWorkspaceSession',
  'createSessionForWorkspace',
  'getSessionGoal',
  'createSessionGoal',
  'editSessionGoal',
  'pauseSessionGoal',
  'resumeSessionGoal',
  'completeSessionGoal',
  'clearSessionGoal',
  'listSessionSubagents',
  'promptSessionSubagent',
  'interruptSessionSubagent',
] as const

/** 产品级 Host 动作联合类型。 */
export type DshHostOperation = (typeof DSH_HOST_OPERATIONS)[number]

/** 单个产品动作对应的底层 Remote endpoint 与载荷转换器。 */
export interface RpcCandidate {
  readonly endpoint: string
  readonly payload: (value: Record<string, unknown>) => Record<string, unknown>
}

/** 判断动作是否属于目标或子智能体等可选业务插件能力。 */
export function isPluginOperation(operation: DshHostOperation): boolean {
  return (
    operation.endsWith('SessionGoal') ||
    operation.endsWith('SessionSubagent') ||
    operation === 'listSessionSubagents'
  )
}

/** 产品动作到固定 Remote endpoint 的映射表。 */
export const OPERATION_CANDIDATES: Record<DshHostOperation, readonly RpcCandidate[]> = {
  getSessionGoal: [{ endpoint: 'goals/get', payload: value => parseGoalArgument(value, 'get') }],
  createSessionGoal: [
    { endpoint: 'goals/create', payload: value => parseGoalArgument(value, 'create') },
  ],
  editSessionGoal: [{ endpoint: 'goals/edit', payload: value => parseGoalArgument(value, 'edit') }],
  pauseSessionGoal: [
    { endpoint: 'goals/pause', payload: value => parseGoalArgument(value, 'transition') },
  ],
  resumeSessionGoal: [
    { endpoint: 'goals/resume', payload: value => parseGoalArgument(value, 'transition') },
  ],
  completeSessionGoal: [
    { endpoint: 'goals/complete', payload: value => parseGoalArgument(value, 'transition') },
  ],
  clearSessionGoal: [
    { endpoint: 'goals/clear', payload: value => parseGoalArgument(value, 'transition') },
  ],
  listSessionSubagents: [
    { endpoint: 'subagents/list', payload: value => parseSubagentArgument(value, 'list') },
  ],
  promptSessionSubagent: [
    { endpoint: 'subagents/prompt', payload: value => parseSubagentArgument(value, 'prompt') },
  ],
  interruptSessionSubagent: [
    {
      endpoint: 'subagents/interruptByParent',
      payload: value => parseSubagentArgument(value, 'interrupt'),
    },
  ],
  describe: [{ endpoint: 'host.describe', payload: directPayload }],
  listSessions: [{ endpoint: 'session/list', payload: () => ({ args: { _request: {} } }) }],
  searchSessions: [
    {
      endpoint: 'session/search',
      payload: value => wrapRequestArgument(parseSearchSessionsArgument(value)),
    },
  ],
  listFileReferences: [{ endpoint: 'fileReferences/list', payload: parseFileReferencesArgument }],
  createSession: [{ endpoint: 'session/create', payload: wrapRequestArgument }],
  renameSession: [
    {
      endpoint: 'session/rename',
      payload: value => wrapRequestArgument(parseRenameSessionArgument(value)),
    },
  ],
  forkSession: [
    {
      endpoint: 'session/fork',
      payload: value => wrapRequestArgument(parseForkSessionArgument(value)),
    },
  ],
  listMessageFeedback: [
    { endpoint: 'messageFeedback/list', payload: parseMessageFeedbackListArgument },
  ],
  putMessageFeedback: [
    { endpoint: 'messageFeedback/put', payload: parseMessageFeedbackPutArgument },
  ],
  deleteMessageFeedback: [
    { endpoint: 'messageFeedback/delete', payload: parseMessageFeedbackDeleteArgument },
  ],
  loadSessionPage: [{ endpoint: 'session/page', payload: parseModernPageArgument }],
  getSessionAttachment: [
    { endpoint: 'session/attachment', payload: parseSessionAttachmentArgument },
  ],
  getSessionModels: [
    { endpoint: 'session/modelCatalog', payload: parseSessionModelCatalogArgument },
  ],
  selectSessionModel: [{ endpoint: 'session/selectModel', payload: parseSelectModelArgument }],
  selectPermissionPreset: [
    { endpoint: 'commands/execute', payload: parsePermissionCommandArgument },
  ],
  listSessionCommands: [{ endpoint: 'commands/list', payload: parseSessionCommandsArgument }],
  listSessionSkills: [{ endpoint: 'skills/list', payload: parseSessionSkillsArgument }],
  executeSessionCommand: [
    { endpoint: 'commands/execute', payload: parseExecuteSessionCommandArgument },
  ],
  promptSession: [
    {
      endpoint: 'session/prompt',
      payload: value => parseModernPromptArgument(parsePromptSessionArgument(value)),
    },
  ],
  updateSessionQueue: [{ endpoint: 'session/updateQueue', payload: wrapRequestArgument }],
  cancelSession: [{ endpoint: 'session/cancel', payload: wrapRequestArgument }],
  describeSettings: [{ endpoint: 'settings/describe', payload: parseEmptyArgument }],
  openSettingsDocument: [
    { endpoint: 'settings/openSettingsDocument', payload: parseEmptyArgument },
  ],
  mutateSettings: [
    {
      endpoint: 'settings/mutate',
      payload: value => ({ args: parseSettingsMutationArgument(value) }),
    },
  ],
  describeCredentials: [
    {
      endpoint: 'credentials/describe',
      payload: value => ({ args: parseCredentialDescribeArgument(value) }),
    },
  ],
  setCredential: [
    {
      endpoint: 'credentials/set',
      payload: value => ({ args: parseCredentialSetArgument(value) }),
    },
  ],
  unsetCredential: [
    {
      endpoint: 'credentials/unset',
      payload: value => ({ args: parseCredentialUnsetArgument(value) }),
    },
  ],
  listModelProviders: [{ endpoint: 'llm/listConfigurableProviders', payload: parseEmptyArgument }],
  listHostModels: [{ endpoint: 'session/modelCatalog', payload: parseEmptyArgument }],
  discoverProviderModels: [
    { endpoint: 'llm/discoverModels', payload: parseRemoteDiscoverModelsArgument },
  ],
  listAgentPresets: [{ endpoint: 'agentPresets/list', payload: parseEmptyArgument }],
  listPermissionPresets: [{ endpoint: 'permissionPresets/catalog', payload: parseEmptyArgument }],
  selectSessionAgentPreset: [
    { endpoint: 'agentPresets/select', payload: parseSelectSessionAgentPresetArgument },
  ],
  readAgentPreset: [
    {
      endpoint: 'agentPresets/read',
      payload: value => ({ args: parseAgentPresetArgument(value) }),
    },
  ],
  copyAgentPreset: [{ endpoint: 'agentPresets/copy', payload: parseRemoteCopyAgentPresetArgument }],
  openAgentPreset: [
    {
      endpoint: 'settings/openAgentPresetDirectory',
      payload: value => ({ args: parseAgentPresetArgument(value) }),
    },
  ],
  removeAgentPreset: [
    {
      endpoint: 'agentPresets/deletePreset',
      payload: value => ({ args: { id: parseAgentPresetArgument(value).agentPreset } }),
    },
  ],
  listHostPlugins: [{ endpoint: 'pluginInventory/list', payload: parsePluginInventoryArgument }],
  archiveSession: [
    {
      endpoint: 'mydshSessions/archiveSession',
      payload: value => ({ args: parseArchiveSessionArgument(value) }),
    },
  ],
  unarchiveSession: [
    {
      endpoint: 'workspace/unarchiveSession',
      payload: value => wrapRequestArgument(parseArchiveSessionArgument(value)),
    },
  ],
  deleteArchivedSession: [
    {
      endpoint: 'mydshSessions/deleteArchivedSession',
      payload: value => ({ args: parseArchiveSessionArgument(value) }),
    },
  ],
  listWorkspaces: [],
  pickWorkspaceDirectory: [{ endpoint: 'directoryPicker/pick', payload: parseEmptyArgument }],
  createWorkspace: [
    {
      endpoint: 'workspace/create',
      payload: value => wrapRequestArgument(parseCreateWorkspaceArgument(value)),
    },
  ],
  renameWorkspace: [
    {
      endpoint: 'workspace/rename',
      payload: value => wrapRequestArgument(parseRenameWorkspaceArgument(value)),
    },
  ],
  removeWorkspace: [
    {
      endpoint: 'workspace/delete',
      payload: value => wrapRequestArgument(parseWorkspaceArgument(value)),
    },
  ],
  reorderWorkspace: [
    {
      endpoint: 'workspace/insertBefore',
      payload: value => wrapRequestArgument(parseReorderWorkspaceArgument(value)),
    },
  ],
  reorderWorkspaceSession: [
    {
      endpoint: 'workspace/insertSessionBefore',
      payload: value => wrapRequestArgument(parseReorderWorkspaceSessionArgument(value)),
    },
  ],
  createSessionForWorkspace: [
    {
      endpoint: 'session/create',
      payload: value => wrapRequestArgument(parseCreateSessionForWorkspaceArgument(value)),
    },
  ],
}
