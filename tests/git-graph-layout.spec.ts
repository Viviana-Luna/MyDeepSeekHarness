import { describe, expect, it } from 'vitest'

import {
  buildGitGraphRows,
  parseGitReferences,
} from '../src/renderer/src/features/source-control/git-graph-layout.ts'
import type { GitCommit } from '../src/renderer/src/features/source-control/source-control-types.ts'

function commit(hash: string, parents: string[], decorations: string[] = []): GitCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    decorations,
    author: '测试用户',
    time: 1,
    subject: hash,
  }
}

describe('Git 提交图布局', () => {
  it('保留分支、合并父边和分类后的引用', () => {
    const rows = buildGitGraphRows([
      commit(
        'merge',
        ['main-2', 'topic-2'],
        ['HEAD -> refs/heads/main', 'refs/remotes/origin/main', 'tag: refs/tags/v1.0.0'],
      ),
      commit('main-2', ['base']),
      commit('topic-2', ['topic-1'], ['refs/heads/topic']),
      commit('topic-1', ['base']),
      commit('base', []),
    ])

    expect(rows[0]?.parentOutputLaneKeys).toHaveLength(2)
    expect(rows[0]?.outputLanes.map(lane => lane.commitHash)).toEqual(['main-2', 'topic-2'])
    expect(rows[2]?.nodeLane).toBe(1)
    expect(rows[4]?.currentInputLaneKeys).toHaveLength(2)
    expect(parseGitReferences(rows[0]?.commit.decorations ?? [])).toEqual([
      { kind: 'head', label: 'HEAD', fullName: 'HEAD -> refs/heads/main' },
      { kind: 'local', label: 'main', fullName: 'refs/heads/main' },
      { kind: 'remote', label: 'origin/main', fullName: 'refs/remotes/origin/main' },
      { kind: 'tag', label: 'v1.0.0', fullName: 'refs/tags/v1.0.0' },
    ])
  })
})
