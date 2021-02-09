import type { AcceptedPlugin, SourceMap } from 'postcss'
import type { AtImportOptions } from 'postcss-import'
import atImport from 'postcss-import'
import * as fs from 'fs'
import * as path from 'path'
import { resolveStyle } from './resolve'

type LoaderContext = import('webpack').loader.LoaderContext

// 获取一个token，非作为ID，仅用于标记theme文件请求
export function getToken(length: number = 16) {
  return Buffer.from(Buffer.from(`${Date.now()}`).toString('base64'))
    .toString('hex')
    .substr(0, Math.max(6, length))
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

// 将上一个 loader 处理过的 sourceMap 转换为 RawSourceMap
export function getRawSourceMap(map: any) {
  let sourceMap = null
  if (typeof map === 'string') {
    try {
      sourceMap = JSON.parse(map)
    } catch (e) {}
  } else if (map && typeof map === 'object') {
    sourceMap = map
  }
  return sourceMap
}

// 格式化 postcss 处理后的 sourceMap 为 RawSourceMap
export function formatSourceMap(map: SourceMap) {
  const sourceMap = map ? map.toJSON() : undefined
  if (sourceMap) {
    if (sourceMap.file) {
      sourceMap.file = path.resolve(sourceMap.file)
    }
    sourceMap.sources = sourceMap.sources.map((src) => path.resolve(src))
  }
  return sourceMap
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

// 获取通用的插件
export function getCommonPlugins(
  loaderContext: LoaderContext,
  syntax: string,
  cssModules: boolean,
  importOptions?: AtImportOptions | null
) {
  const { rootContext, resolve } = loaderContext
  //
  const plugins = [
    atImport(
      Object.assign(
        {
          root: rootContext,
          // 使用webpack的缓存文件系统读取文件
          load: (filename: string) => readFile(filename, loaderContext.fs || fs),
          // 这里resolve要使用webpack的resolve模块
          // webpack可能配置了resolve别名等
          resolve: (id: string, basedir: string) => resolveStyle(resolve, id, syntax, basedir),
        },
        importOptions
      )
    ),
  ] as AcceptedPlugin[]
  //
  if (cssModules) {
    // cssModules 语法支持
    plugins.push(require('postcss-modules')())
  }
  return plugins
}

// 读取文件内容
export function readFile(resourcePath: string, fileSystem: typeof fs) {
  return new Promise((resolve, reject) => {
    fileSystem.readFile(resourcePath, (err, source: string | Buffer) =>
      err ? reject(err) : resolve(Buffer.isBuffer(source) ? source.toString('utf8') : source)
    )
  }) as Promise<string>
}
