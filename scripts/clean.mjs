import { rmSync } from 'node:fs'

for (const relativePath of [
  '../.build',
  '../lib',
  '../out',
  '../verify.png',
  '../verify-dark.png',
  '../verify-appearance.png',
  '../verify-large.png',
  '../verify-narrow.png',
  '../verify-files.png',
  '../verify-diff.png',
  '../verify-native-settings.png',
  '../verify-crop.png',
  '../verify-clear-islands.png',
  '../verify-clear.png',
]) {
  rmSync(new URL(relativePath, import.meta.url), { recursive: true, force: true })
}
