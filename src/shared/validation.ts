/**
 * 跨进程共享的输入校验工具。
 *
 * 主进程、后台和 renderer 在信任边界处都要判断 IPC、Remote、文件中读到的未知数据。
 * 统一使用这里的实现，避免各文件各写一份后语义悄悄分叉。
 * 本模块保持平台与框架无关，不依赖 Node、Electron 或 React（由 verify-architecture 检查）。
 */

/** 尚未校验字段的普通对象：键为字符串，值类型未知。 */
export type UnknownRecord = Record<string, unknown>

/**
 * 判断值是否是可以按键读取字段的普通对象。
 * null 和数组都不算对象，避免把 JSON 数组误当成对象读取字段。
 */
export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 值是普通对象时原样返回，否则返回 null。
 * 适合逐层读取可选字段：`asRecord(value)?.field`。
 */
export function asRecord(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null
}

/**
 * 读取长度在 1 到 maximum 之间的字符串，不满足时返回 null，由调用方决定如何报错。
 * 长度按 UTF-16 码元计算，与 `String#length` 一致；不会去除首尾空白。
 */
export function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null
}
