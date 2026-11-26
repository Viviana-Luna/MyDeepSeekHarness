import { StreamLanguage } from '@codemirror/language'
import type { Extension } from '@codemirror/state'

type LanguageLoader = () => Promise<Extension>

const LANGUAGE_LOADERS: Readonly<Record<string, LanguageLoader>> = Object.freeze({
  css: async () => (await import('@codemirror/lang-css')).css(),
  go: async () => (await import('@codemirror/lang-go')).go(),
  html: async () => (await import('@codemirror/lang-html')).html(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript(),
  javascriptreact: async () =>
    (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  json: async () => (await import('@codemirror/lang-json')).json(),
  kotlin: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).kotlin),
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  python: async () => (await import('@codemirror/lang-python')).python(),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  shell: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  toml: async () =>
    StreamLanguage.define((await import('@codemirror/legacy-modes/mode/toml')).toml),
  typescript: async () =>
    (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  typescriptreact: async () =>
    (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true }),
  vue: async () => (await import('@codemirror/lang-vue')).vue(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
})

export function codeLanguageKey(language: string): string {
  return language.toLowerCase()
}

export async function loadCodeLanguage(language: string): Promise<Extension> {
  const loader = LANGUAGE_LOADERS[codeLanguageKey(language)]
  return loader === undefined ? [] : loader()
}
