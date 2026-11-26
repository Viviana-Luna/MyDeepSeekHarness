import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@umijs/max': fileURLToPath(new URL('./src/renderer/src/.umi/exports.ts', import.meta.url)),
      umi: fileURLToPath(new URL('./src/renderer/src/.umi/exports.ts', import.meta.url)),
      '@@': fileURLToPath(new URL('./src/renderer/src/.umi', import.meta.url)),
      '@': fileURLToPath(new URL('./src/renderer/src', import.meta.url)),
    },
    dedupe: ['react', 'react-dom'],
  },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx', 'tests/**/*.spec.mjs'],
    pool: 'forks',
    // 用例会启动真实 git、esbuild 与 TypeScript；Windows 并发多 fork 启动更慢，放宽超时避免误判。
    testTimeout: process.platform === 'win32' ? 40_000 : 20_000,
    hookTimeout: process.platform === 'win32' ? 30_000 : 20_000,
  },
})
