import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DesktopProjectTaskEvent } from '../src/shared/project-tasks.ts'
import { ProjectTaskService } from '../src/main/tasks/project-task-controller.ts'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mydsh-project-tasks-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('用户项目任务配置', () => {
  it('持久化受限启动配置，并为用户终端解析真实工作目录', async () => {
    const root = temporaryRoot()
    const project = join(root, 'project')
    const serviceDirectory = join(project, 'service')
    mkdirSync(serviceDirectory, { recursive: true })
    const events: DesktopProjectTaskEvent[] = []
    const storagePath = join(root, 'user-data', 'project-tasks.json')
    const service = new ProjectTaskService(
      storagePath,
      id =>
        id === 'project-1'
          ? project
          : (() => {
              throw new Error('未知项目')
            })(),
      event => {
        events.push(event)
      },
    )
    const task = await service.save({
      projectId: 'project-1',
      name: '启动服务',
      executable: 'pnpm',
      args: ['run', 'dev'],
      cwd: 'service',
      env: { NODE_ENV: 'development' },
      allowConcurrent: false,
    })

    expect(events).toContainEqual({ type: 'snapshot', projectId: 'project-1', task })
    expect(await service.resolveLaunch('project-1', task.id)).toEqual({
      taskId: task.id,
      name: '启动服务',
      executable: 'pnpm',
      args: ['run', 'dev'],
      cwd: realpathSync.native(serviceDirectory),
      env: { NODE_ENV: 'development' },
      allowConcurrent: false,
    })

    const restored = new ProjectTaskService(
      storagePath,
      () => project,
      () => undefined,
    )
    expect(await restored.list('project-1')).toEqual([task])
  })

  it('拒绝越界工作目录、缺失目录和跨项目任务标识', async () => {
    const root = temporaryRoot()
    const project = join(root, 'project')
    mkdirSync(project)
    const service = new ProjectTaskService(
      join(root, 'project-tasks.json'),
      () => project,
      () => undefined,
    )

    await expect(
      service.save({
        projectId: 'project-1',
        name: '越界',
        executable: 'node',
        args: [],
        cwd: '../outside',
        env: {},
        allowConcurrent: false,
      }),
    ).rejects.toThrow('项目任务工作目录必须位于项目根目录内')

    const task = await service.save({
      projectId: 'project-1',
      name: '目录稍后创建',
      executable: 'node',
      args: [],
      cwd: 'missing',
      env: {},
      allowConcurrent: false,
    })
    await expect(service.resolveLaunch('project-1', task.id)).rejects.toThrow(
      '项目任务工作目录不存在',
    )
    await expect(service.resolveLaunch('project-2', task.id)).rejects.toThrow(
      '项目任务不存在或不属于当前项目',
    )
  })
})
