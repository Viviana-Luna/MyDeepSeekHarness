import type { GitCommit } from './source-control-types.ts'

export const GIT_GRAPH_ROW_HEIGHT = 46
export const GIT_GRAPH_LANE_SPACING = 11
const GIT_GRAPH_LANE_OFFSET = 7
const GIT_GRAPH_COLOR_COUNT = 5

export interface GitGraphLane {
  key: string
  commitHash: string
  colorIndex: number
}

export interface GitGraphRowLayout {
  commit: GitCommit
  inputLanes: GitGraphLane[]
  outputLanes: GitGraphLane[]
  nodeLane: number
  nodeColorIndex: number
  currentInputLaneKeys: string[]
  parentOutputLaneKeys: string[]
}

export type GitReferenceKind = 'head' | 'local' | 'remote' | 'tag'

export interface GitReference {
  kind: GitReferenceKind
  label: string
  fullName: string
}

function shortReferenceName(value: string): string {
  return value
    .replace(/^refs\/heads\//u, '')
    .replace(/^refs\/remotes\//u, '')
    .replace(/^refs\/tags\//u, '')
}

export function parseGitReferences(decorations: readonly string[]): GitReference[] {
  const references: GitReference[] = []
  const add = (kind: GitReferenceKind, label: string, fullName: string) => {
    if (
      label === '' ||
      references.some(reference => reference.kind === kind && reference.label === label)
    )
      return
    references.push({ kind, label, fullName })
  }

  for (const decoration of decorations) {
    const value = decoration.trim()
    if (value === '') continue
    if (value === 'HEAD') {
      add('head', 'HEAD', value)
      continue
    }
    if (value.startsWith('HEAD -> ')) {
      const target = value.slice('HEAD -> '.length)
      add('head', 'HEAD', value)
      add('local', shortReferenceName(target), target)
      continue
    }
    if (value.startsWith('tag: ')) {
      const target = value.slice('tag: '.length)
      add('tag', shortReferenceName(target), target)
      continue
    }
    if (value.startsWith('refs/tags/')) {
      add('tag', shortReferenceName(value), value)
      continue
    }
    if (value.startsWith('refs/remotes/')) {
      add('remote', shortReferenceName(value), value)
      continue
    }
    if (value.startsWith('refs/heads/')) {
      add('local', shortReferenceName(value), value)
      continue
    }
    add(value.includes('/') ? 'remote' : 'local', value, value)
  }
  return references
}

export function buildGitGraphRows(commits: readonly GitCommit[]): GitGraphRowLayout[] {
  let lanes: GitGraphLane[] = []
  let laneSequence = 0
  let colorSequence = -1

  const createLane = (commitHash: string, colorIndex?: number): GitGraphLane => {
    if (colorIndex === undefined) colorSequence = (colorSequence + 1) % GIT_GRAPH_COLOR_COUNT
    return {
      key: `lane-${String(laneSequence++)}`,
      commitHash,
      colorIndex: colorIndex ?? colorSequence,
    }
  }

  return commits.map(commit => {
    const inputLanes = lanes.map(lane => ({
      key: lane.key,
      commitHash: lane.commitHash,
      colorIndex: lane.colorIndex,
    }))
    const currentInputLaneKeys = inputLanes
      .filter(lane => lane.commitHash === commit.hash)
      .map(lane => lane.key)
    const nodeLane = inputLanes.findIndex(lane => lane.commitHash === commit.hash)
    const resolvedNodeLane = nodeLane === -1 ? inputLanes.length : nodeLane
    const currentLane = nodeLane === -1 ? undefined : inputLanes[nodeLane]
    const fallbackLane = currentLane ?? createLane(commit.hash)
    const outputLanes: GitGraphLane[] = []
    const parentOutputLaneKeys: string[] = []
    let firstParentAdded = false

    for (const lane of inputLanes) {
      if (lane.commitHash !== commit.hash) {
        outputLanes.push({ ...lane })
        continue
      }
      const firstParent = commit.parents[0]
      if (!firstParentAdded && firstParent !== undefined) {
        outputLanes.push({ ...lane, commitHash: firstParent })
        parentOutputLaneKeys.push(lane.key)
        firstParentAdded = true
      }
    }

    if (!firstParentAdded && commit.parents[0] !== undefined) {
      const firstParentLane = createLane(commit.parents[0], fallbackLane.colorIndex)
      outputLanes.push(firstParentLane)
      parentOutputLaneKeys.push(firstParentLane.key)
      firstParentAdded = true
    }

    for (let index = firstParentAdded ? 1 : 0; index < commit.parents.length; index += 1) {
      const parent = commit.parents[index]
      if (parent === undefined) continue
      const parentLane = createLane(parent)
      outputLanes.push(parentLane)
      parentOutputLaneKeys.push(parentLane.key)
    }

    lanes = outputLanes
    return {
      commit,
      inputLanes,
      outputLanes,
      nodeLane: resolvedNodeLane,
      nodeColorIndex: fallbackLane.colorIndex,
      currentInputLaneKeys,
      parentOutputLaneKeys,
    }
  })
}

export function gitGraphWidth(rows: readonly GitGraphRowLayout[]): number {
  const laneCount = rows.reduce(
    (maximum, row) =>
      Math.max(maximum, row.inputLanes.length, row.outputLanes.length, row.nodeLane + 1),
    1,
  )
  return GIT_GRAPH_LANE_OFFSET + laneCount * GIT_GRAPH_LANE_SPACING + 5
}

export function gitGraphLaneX(index: number): number {
  return GIT_GRAPH_LANE_OFFSET + index * GIT_GRAPH_LANE_SPACING
}
