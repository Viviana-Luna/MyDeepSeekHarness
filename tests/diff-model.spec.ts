import { describe, expect, it } from 'vitest'

import {
  pairDiffRows,
  parseUnifiedDiff,
} from '../src/renderer/src/features/source-control/diff-model.ts'

describe('Unified Diff 行模型', () => {
  it('保留代码前缀和双侧行号，隐藏补丁头并配对替换行', () => {
    const rows = parseUnifiedDiff(
      [
        'diff --git a/src/main.ts b/src/main.ts',
        'index 1111111..2222222 100644',
        '--- a/src/main.ts',
        '+++ b/src/main.ts',
        '@@ -3,3 +5,4 @@ function run() {',
        ' 保留第一行',
        '---count;',
        '+++count;',
        '+新增第二行',
        ' 保留末行',
        '\\ No newline at end of file',
        '@@ -20 +22 @@ function finish() {',
        '-timeout = 5000;',
        '+timeout = 8000;',
      ].join('\n'),
    )

    expect(rows).toEqual([
      { kind: 'hunk', text: '旧版第 3 行 · 新版第 5 行', oldLine: null, newLine: null },
      { kind: 'context', text: '保留第一行', oldLine: 3, newLine: 5 },
      { kind: 'deletion', text: '--count;', oldLine: 4, newLine: null },
      { kind: 'addition', text: '++count;', oldLine: null, newLine: 6 },
      { kind: 'addition', text: '新增第二行', oldLine: null, newLine: 7 },
      { kind: 'context', text: '保留末行', oldLine: 5, newLine: 8, noNewline: true },
      { kind: 'hunk', text: '旧版第 20 行 · 新版第 22 行', oldLine: null, newLine: null },
      { kind: 'deletion', text: 'timeout = 5000;', oldLine: 20, newLine: null },
      { kind: 'addition', text: 'timeout = 8000;', oldLine: null, newLine: 22 },
    ])
    const pairs = pairDiffRows(rows)
    expect(pairs[2]).toMatchObject({
      left: { text: '--count;', changed: [0, 2] },
      right: { text: '++count;', changed: [0, 2] },
    })
    expect(pairs[3]).toMatchObject({ left: null, right: { newLine: 7 } })
    expect(pairs.at(-1)).toMatchObject({
      left: { oldLine: 20, changed: [10, 11] },
      right: { newLine: 22, changed: [10, 11] },
    })
  })

  it('分块之外不虚构代码，权限与空文件变化保留可读说明', () => {
    expect(
      parseUnifiedDiff(
        [
          'diff --git a/script.sh b/script.sh',
          'old mode 100644',
          'new mode 100755',
          'diff --git a/empty.txt b/empty.txt',
          'new file mode 100644',
          '--- /dev/null',
          '+++ b/empty.txt',
          '+不属于任何分块',
        ].join('\n'),
      ),
    ).toEqual([
      { kind: 'meta', text: '新增可执行权限', oldLine: null, newLine: null },
      { kind: 'meta', text: '新文件', oldLine: null, newLine: null },
    ])
  })
})
