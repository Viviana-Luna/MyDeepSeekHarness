import { defineConfig } from '@umijs/max'
import { dirname } from 'node:path'
import routes from './routes'

/** Pro 的 Umi 工程配置；Electron 只加载本地产物，网络与本机权限归主进程。 */
export default defineConfig({
  npmClient: 'pnpm',
  routes,
  history: { type: 'memory' },
  publicPath: process.env.NODE_ENV === 'production' ? './' : '/',
  outputPath: '../../lib/renderer',
  hash: true,
  esbuildMinifyIIFE: true,
  devtool: 'source-map',
  mfsu: false,
  model: {},
  // 依赖统一声明在仓库根目录；子目录启动 Umi 时显式复用，避免选中框架内置旧版本。
  alias: {
    react: dirname(require.resolve('react/package.json')),
    'react-dom': dirname(require.resolve('react-dom/package.json')),
    antd: dirname(require.resolve('antd/package.json')),
  },
  chainWebpack(config) {
    // 跨进程共享源码按 NodeNext 使用 .js 导入；前端构建将其解析到 TypeScript 源文件。
    config.resolve.set('extensionAlias', { '.js': ['.js', '.ts', '.tsx'] })
    // 当前 Webpack 的内部依赖分析会把 xterm 6 的 TaskQueue 父类替换为 null。
    // 关闭该项分析，保留正常压缩与模块拆分；升级构建依赖后用真实终端验收再评估。
    config.optimization.set('innerGraph', false)
  },
  title: 'MyDSH',
  metas: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1.0' },
    { name: 'color-scheme', content: 'dark light' },
    {
      'http-equiv': 'Content-Security-Policy',
      content:
        "default-src 'self' data:; img-src 'self' data: blob: mydsh-plugin:; font-src 'self' data: mydsh-plugin:; style-src 'self' 'unsafe-inline' mydsh-plugin:; script-src 'self' mydsh-plugin:; connect-src 'self' ws://127.0.0.1:4175; object-src 'none'; base-uri 'none'; form-action 'none'",
    },
  ],
})
