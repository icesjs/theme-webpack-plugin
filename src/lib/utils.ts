import * as fs from 'fs'
import * as path from 'path'
import { parseQuery } from 'loader-utils'
import type { Message, Root, Syntax } from 'postcss'

const astSymbol = Symbol('ThemeLoaderAstMeta')

type PostcssASTMeta = {
  type: 'postcss'
  messages?: Message[]
  root?: Root
  version?: string
}

export type SupportedSyntax = 'scss' | 'sass' | 'less' | 'css'

// 主题请求标识符token
export const themeRequestToken = getToken()

// 常见的web资源模块的后缀名称
export const normalModuleRegx = /\.(?:m?js|node|jsx|tsx?|json|html?|ya?ml|css|less|s[ac]ss|stylus|styl|bmp|ico|gif|jpe?g|png|svg|avif|md|eot|woff|otf|ttf|mp[34]|ogg)$/i

// 获取一个token，非作为ID，仅用于标记theme文件请求
export function getToken(length: number = 8) {
  return Buffer.from(Buffer.from(`${Date.now()}`).toString('base64'))
    .toString('hex')
    .substr(0, Math.max(6, length))
}

// 从元数据中获取postcss的抽象语法树
export function getASTFromMeta(meta: any): PostcssASTMeta {
  let astMeta
  if (hasOwnProperty(meta, astSymbol)) {
    astMeta = Reflect.get(meta, astSymbol)
  } else {
    astMeta = {}
  }
  return { ...astMeta, type: 'postcss' }
}

// 创建共享元数据
export function createASTMeta(meta: Omit<PostcssASTMeta, 'type'>, prevMeta: any) {
  return Object.defineProperties(Object.assign({}, prevMeta), {
    [astSymbol]: { value: { ...meta } },
  })
}

// 解析查询参数为一个对象
export function getQueryObject(resourceQuery: any): { token?: string; [p: string]: any } {
  if (resourceQuery) {
    if (typeof resourceQuery === 'object') {
      return resourceQuery
    }
    if (typeof resourceQuery === 'string') {
      return parseQuery(resourceQuery.startsWith('?') ? resourceQuery : `?${resourceQuery}`)
    }
  }
  return {}
}

// 获取资源请求的查询参数字符串（?xxx）
export function getQueryString(resource: any) {
  return typeof resource === 'string'
    ? resource
        .split('!')
        .pop()!
        .replace(/^.*?(?=\?|$)/, '')
    : ''
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
  if (!x || !y || typeof x !== 'string' || typeof y !== 'string') {
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
export function getSupportedSyntax(syntax: any): SupportedSyntax {
  syntax = typeof syntax === 'string' ? syntax.toLowerCase() : ''
  if (!isStylesheet(`.${syntax}`)) {
    syntax = 'css'
  }
  return syntax
}

// 读取文件内容
export function readFile(resourcePath: string, fileSystem: typeof fs): Promise<string> {
  return new Promise((resolve, reject) => {
    fileSystem.readFile(resourcePath, (err, source: string | Buffer) =>
      err ? reject(err) : resolve(Buffer.isBuffer(source) ? source.toString('utf8') : source)
    )
  })
}

// 对象上是否包含属性
export function hasOwnProperty(obj: any, prop: PropertyKey, valueType?: string) {
  if (obj === null || obj === undefined) {
    return false
  }
  const hasProp = Object.prototype.hasOwnProperty.call(obj, prop)
  return hasProp && (valueType ? typeof obj[prop] === valueType : true)
}

// 判断模块导出是不是esModule格式
export function isEsModuleExport(exports: any) {
  return hasOwnProperty(exports, '__esModule', 'boolean')
}

// 格式化部署路径
export function normalizePublicPath(publicPath: any): string {
  if (typeof publicPath !== 'string' || publicPath === '') {
    return './'
  }
  publicPath = publicPath.replace(/\\/g, '/').trim()
  return publicPath.endsWith('/') ? publicPath : `${publicPath}/`
}

// 格式化相对路径
export function normalizeRelativePath(filepath: string, context?: string) {
  filepath = filepath.trim()
  if (context && path.isAbsolute(filepath)) {
    filepath = path.relative(context, filepath)
  }
  if (!path.isAbsolute(filepath) && !filepath.startsWith('.')) {
    filepath = `./${filepath}`
  }
  return filepath.replace(/\\/g, '/')
}

// 判断是不是相对地址
export function isRelativeURI(uri: string) {
  if (typeof (uri as any) !== 'string' || !uri) {
    return false
  }
  return (
    !/^([a-z]:)?[/\\]/i.test(uri) &&
    !/^(?:\w+:)?\/\/(\S+)$/.test(uri) &&
    !/^[/\\]{2,}[^/\\]+[/\\]+[^/\\]+/.test(uri)
  )
}

// 获取发出资源请求的来源文件
export function tryGetCodeIssuerFile(module: any) {
  if (!module) {
    return ''
  }
  let issuer = module
  while ((issuer = issuer.issuer)) {
    const { resource } = issuer
    if (typeof resource === 'string' && /\.(?:js|mjs|jsx|ts|tsx|vue)$/i.test(resource)) {
      return resource
    }
  }
  return ''
}

// 转义正则元字符
export function escapeRegExpChar(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '\\x2d')
}

// 确保文件拥有指定的扩展名
export function ensureFileExtension(filename: string, ext: string) {
  return filename.replace(/\s*(?:\.(?:[^.]+)?|)$/, ext)
}

// 拷贝对象属性中值为非undefined的字段，并返回一个新的对象
export function trimUndefined<T extends object>(obj?: object): T {
  return Object.entries(obj || {}).reduce((obj, [key, value]) => {
    if (typeof value !== 'undefined') {
      obj[key] = value
    }
    return obj
  }, {} as any)
}

// 去掉查询字符串
export function trimQueryString(filepath: any) {
  if (typeof filepath === 'string') {
    return filepath.replace(/\?.*/, '')
  }
  return ''
}

// 获取语法解析插件
export function getSyntaxPlugin(syntax: SupportedSyntax): Syntax {
  let plugin = require(`postcss-${syntax === 'css' ? 'safe-parser' : syntax}`)
  if (typeof plugin === 'function') {
    plugin = {
      parse: plugin,
      stringify: require('postcss').stringify,
    }
  }
  return plugin
}
