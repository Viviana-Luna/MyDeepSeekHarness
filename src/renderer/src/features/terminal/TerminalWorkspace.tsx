import { TerminalSquare } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { DESKTOP_TERMINAL_LIMITS } from '../../../../shared/terminal.ts'
import { useWorkspaceSnapshot, useWorkspaceStore } from '../../hooks/useWorkspace.ts'
import type { IslandPresentationProps } from '../../plugins/registry.ts'
import { CapabilityState } from '../../shared/ui/CapabilityState.tsx'
import { useProjectTasks } from '../project-tasks/ProjectTasksProvider.tsx'
import { TerminalView } from './TerminalView.tsx'
import styles from './TerminalView.module.css'

interface TerminalProject {
  readonly id: string
  readonly name: string
}

/** 终端跟随当前项目；切走的项目保留标签与 PTY，直到用户关闭或退出应用。 */
export function TerminalWorkspace({ placement, visibility }: IslandPresentationProps) {
  const store = useWorkspaceStore()
  const snapshot = useWorkspaceSnapshot()
  const tasks = useProjectTasks()
  const visible = visibility === 'foreground'
  const availableProjects = useMemo<TerminalProject[]>(
    () =>
      snapshot.projects.flatMap(project =>
        project.projectAccessId === undefined
          ? []
          : [{ id: project.projectAccessId, name: project.name }],
      ),
    [snapshot.projects],
  )
  const selectedProject = store.selectedProject()
  const activeProjectId = selectedProject?.projectAccessId ?? null
  const activeProjectName = selectedProject?.name ?? '当前项目'
  const [mountedProjects, setMountedProjects] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  )
  const [tabCounts, setTabCounts] = useState<Readonly<Record<string, number>>>({})

  const mountProject = useCallback((project: TerminalProject) => {
    setMountedProjects(current => {
      if (current.get(project.id) === project.name) return current
      const next = new Map(current)
      next.set(project.id, project.name)
      return next
    })
  }, [])
  useEffect(() => {
    const request = tasks.launchRequest
    if (request === null) return
    mountProject({ id: request.projectId, name: request.projectName })
  }, [mountProject, tasks.launchRequest])

  useEffect(() => {
    if (visible && activeProjectId !== null) {
      mountProject({ id: activeProjectId, name: activeProjectName })
    }
  }, [activeProjectId, activeProjectName, mountProject, visible])

  const totalTabs = Object.values(tabCounts).reduce((total, count) => total + count, 0)
  const canCreate = totalTabs < DESKTOP_TERMINAL_LIMITS.maxTerminals

  return (
    <section
      className={`workspace-view ${styles.workspace}`}
      aria-label="当前项目终端"
      hidden={!visible}
    >
      <div className={styles.projectGroups}>
        {activeProjectId === null && (
          <CapabilityState
            icon={TerminalSquare}
            title="请选择一个可访问的项目"
            detail="在左侧选择项目，终端会使用该项目的工作目录。"
          />
        )}
        {[...mountedProjects].map(([projectId, rememberedName]) => {
          const projectName =
            availableProjects.find(project => project.id === projectId)?.name ?? rememberedName
          const active = visible && projectId === activeProjectId
          const request = tasks.launchRequest?.projectId === projectId ? tasks.launchRequest : null
          return (
            <TerminalView
              key={projectId}
              projectId={projectId}
              projectName={projectName}
              visible={active}
              canCreate={canCreate}
              launchRequest={request}
              onOpenInMain={
                placement === 'right'
                  ? () => {
                      const intent = store.captureIslandCollaborationIntent()
                      if (intent !== null)
                        store.presentIslandCollaboration(intent, 'terminal', 'main')
                    }
                  : undefined
              }
              onConsumeLaunchRequest={tasks.consumeLaunchRequest}
              onTabCountChange={count => {
                setTabCounts(current =>
                  current[projectId] === count ? current : { ...current, [projectId]: count },
                )
              }}
            />
          )
        })}
      </div>
    </section>
  )
}
