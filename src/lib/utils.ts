import * as fs from 'fs'
import * as path from 'path'
import { parseQuery } from 'loader-utils'

// 获取一个token，非作为ID，仅用于标记theme文件请求
export function getToken(length: number = 16) {
  return Buffer.from(Buffer.from(`${Date.now()}`).toString('base64'))
    .toString('hex')
    .substr(0, Math.max(6, length))
}

// 解析查询参数为一个对象
export function getQueryObject(resourceQuery: string) {
  if (resourceQuery && resourceQuery.startsWith('?')) {
    return parseQuery(resourceQuery)
  }
  return {}
}

// 判断一个文件是否在某些根路径下
export function containFile(roots: string | string[], file: string) {
  if (!Array.isArray(roots)) {
    roots = [roots]
  }
  file = file.replace(/\\/g, '/').toLowerCase()
  return roots.some((root) => file.startsWith(root.replace(/\\/g, '/').toLowerCase()))
}

// 判断是不是样式文件
// 当前支持的类型
export function isStylesheet(file: string) {
  return /\.(?:css|s[ac]ss|less)$/i.test(file)
}

// 判断是否是相同的地址
export function isSamePath(x: any, y: any) {
  if (typeof x !== 'string' || typeof y !== 'string') {
    return false
  }
  return path.normalize(x).toLowerCase() === path.normalize(y).toLowerCase()
}

// 获取主题的名称
export function getFileThemeName(file: string) {
  return path.basename(file, path.extname(file)).toLowerCase()
}

// 获取有效的语法名称
// 即当前支持的解析语法
export function getValidSyntax(syntax: any) {
  syntax = typeof syntax === 'string' ? syntax.toLowerCase() : ''
  if (!isStylesheet(`.${syntax}`)) {
    syntax = 'css'
  }
  return syntax as 'scss' | 'sass' | 'less' | 'css'
}

// 读取文件内容
export function readFile(resourcePath: string, fileSystem: typeof fs) {
  return new Promise((resolve, reject) => {
    fileSystem.readFile(resourcePath, (err, source: string | Buffer) =>
      err ? reject(err) : resolve(Buffer.isBuffer(source) ? source.toString('utf8') : source)
    )
  }) as Promise<string>
}
