/**
 * 预设内置二级能力 Skills 挂载器：向标准模式与 ChatGPT 模式注入随包交付的 `mydsh` 二级 CLI 与插件开发技能。
 * 运行在后台 Runtime；不依赖预设文件所在目录，因此用户复制预设到个人目录后依然正常生效。
 */
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import type { Config as SkillFilesystemConfig } from '@deepseek-ai/dsh-skill-filesystem'

/** 随 `@mydsh/cli-bridge` 包交付的内置 Skills 根目录。 */
export const BUNDLED_CLI_SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))

/** Cordis 插件名称。 */
export const name = 'mydsh-preset-skills'

/** 转发给底层文件系统 Skill 提供方的依赖列表。 */
export const inject = SkillFilesystem.inject

/** 挂载项目/用户默认 Skills 目录以及 MyDSH 二级受控能力内置 Skills（按 bundled 优先级，允许用户覆盖）。 */
export function apply(ctx: Context, config: SkillFilesystemConfig = {}): void {
  SkillFilesystem.apply(ctx, {
    ...config,
    bundledSkillDir: config.bundledSkillDir ?? BUNDLED_CLI_SKILLS_DIR,
  })
}
