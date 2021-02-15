import * as fs from 'fs'
import type { AcceptedPlugin, Message, Syntax } from 'postcss'
import postcss from 'postcss'
import type { AtImportOptions } from 'postcss-import'
import atImport from 'postcss-import'
import { getOptions } from 'loader-utils'
import { PluginLoader } from '../Plugin'
import { selfModuleName } from '../lib/selfContext'
import { getQueryObject, getValidSyntax, isSamePath, isStylesheet, readFile } from '../lib/utils'
import { ThemeLoaderData, ThemeVarsMessage } from '../lib/postcss/tools'
import { getVarsMessages } from '../lib/postcss/helper'
import {
  exportVarsPlugin,
  extractContextVarsPlugin,
  extractThemeVarsPlugin,
  extractTopScopeVarsPlugin,
  extractVariablesPlugin,
  extractVarsPlugin,
} from '../lib/postcss/plugins'
import { resolveStyle } from '../lib/resolve'

type WebpackLoaderContext = import('webpack').loader.LoaderContext

export interface VarsLoaderOptions {
  cssModules: boolean | { [p: string]: any }
  onlyColor: boolean
  syntax: string
  token: string
}

interface LoaderData extends ThemeLoaderData {
  readonly isStylesheet: boolean
  readonly isThemeFile: boolean
  readonly isThemeRequest: boolean
  readonly syntaxPlugin: Syntax
  readonly themeFiles: string[]
  readonly fileSystem: typeof fs
  readonly options: VarsLoaderOptions
}

interface LoaderContext extends WebpackLoaderContext {
  readonly data: LoaderData
}

async function setVarsData(loaderContext: LoaderContext, messages: Message[]) {
  const { data } = loaderContext
  const { isThemeRequest } = data

  if (!isThemeRequest) {
    data.variablesMessages = await getVariablesMessages(loaderContext, messages)
    data.contextMessages = getContextMessages(messages)
  } else {
    data.themeMessages = getThemeVarsMessages(messages)
  }
}

// 判断是不是主题文件
function isThemeFile(file: string, themeFiles: string[]) {
  return themeFiles.some((theme) => isSamePath(file, theme))
}

// 判断是不是依赖的主题文件
function isThemeDependency({ type, plugin, file }: Message, themeFiles: string[]) {
  return type === 'dependency' && plugin === 'postcss-import' && isThemeFile(file, themeFiles)
}

// 获取主题依赖
function getThemeDependencies(messages: Message[], themeFiles: string[]) {
  return messages.filter((msg) => isThemeDependency(msg, themeFiles)).map(({ file }) => file)
}

// 获取来自于主题文件的变量
async function extractThemeVars(loaderContext: LoaderContext, themeDependencies: string[]) {
  const { options, syntaxPlugin, fileSystem } = loaderContext.data
  const { syntax, onlyColor } = options
  const extractOptions = { syntax, syntaxPlugin, onlyColor }
  const themeVars = new Map<string, ThemeVarsMessage>()

  for (const file of themeDependencies) {
    const source = await readFile(file, fileSystem)

    // 处理主题文件
    const { messages } = await postcss([
      //
      ...getCommonPlugins(loaderContext),
      extractThemeVarsPlugin(extractOptions),
      //
    ]).process(source, {
      syntax: syntaxPlugin,
      from: file,
      map: false,
    })

    // 合并变量
    for (const msg of getVarsMessages(messages, 'theme-root-vars')) {
      themeVars.set(msg.ident, msg)
    }
    for (const msg of getVarsMessages(messages, 'theme-vars')) {
      themeVars.set(msg.ident, msg)
    }
  }

  // 转换为数组
  return [...themeVars.values()]
}

// 获取可用的全局变量
async function getVariablesMessages(loaderContext: LoaderContext, messages: Message[]) {
  const { themeFiles } = loaderContext.data
  return extractThemeVars(loaderContext, getThemeDependencies(messages, themeFiles))
}

// 获取当前样式文件的本地变量
function getContextMessages(messages: Message[]) {
  return getVarsMessages(messages, 'theme-context')
}

// 获取主题变量
function getThemeVarsMessages(messages: Message[]) {
  return getVarsMessages(
    messages,
    ({ type }) => type === 'theme-vars' || type === 'theme-root-vars'
  )
}

// 获取语法插件模块
function getSyntaxPlugin(syntax: string) {
  return require(`postcss-${syntax === 'css' ? 'safe-parser' : syntax}`) as Syntax
}

// 获取通用插件模块
function getCommonPlugins(loaderContext: LoaderContext, importOptions: AtImportOptions = {}) {
  const { rootContext, resolve, data } = loaderContext
  const { options, fileSystem } = data
  const { syntax, cssModules } = options
  //
  const plugins = [
    atImport({
      root: rootContext,
      skipDuplicates: true,
      // 使用webpack的缓存文件系统读取文件
      load: (filename: string) => readFile(filename, fileSystem),
      // 这里resolve要使用webpack的resolve模块，webpack可能配置了resolve别名等
      resolve: (id: string, basedir: string) => resolveStyle(resolve, id, syntax, basedir),
      ...importOptions,
    }),
  ] as AcceptedPlugin[]
  //
  if (cssModules) {
    // cssModules 语法支持
    plugins.push(require('postcss-modules')(Object.assign({}, cssModules)))
  }

  return plugins
}

// 抽取变量并返回样式定义
async function extractTopScopeVars(loaderContext: LoaderContext, source: string, filename: string) {
  const { syntaxPlugin, options } = loaderContext.data
  const { syntax, onlyColor } = options
  const extractOptions = { syntax, syntaxPlugin, onlyColor }
  // 提取变量
  const messages = await postcss([
    ...getCommonPlugins(loaderContext),
    // 抽取顶级作用域变量
    extractTopScopeVarsPlugin({ ...extractOptions, parseValue: false }),
  ])
    .process(source, {
      syntax: syntaxPlugin,
      from: filename,
      map: false,
    })
    .then(({ messages }) => getThemeVarsMessages(messages))

  // 生成一个新的文件
  return (
    await postcss([exportVarsPlugin({ ...extractOptions, messages })]).process(
      `/* Theme Variables extracted by ${selfModuleName} */\n\n`,
      {
        syntax: syntaxPlugin,
        from: undefined,
        map: false,
      }
    )
  ).css
}

// 获取配置对象
function getLoaderOptions(loaderContext: WebpackLoaderContext) {
  const { ...options } = getOptions(loaderContext) as any
  options.syntax = getValidSyntax(options.syntax)
  return options as VarsLoaderOptions
}

// 获取插件列表
function getPostcssPlugins(loaderContext: LoaderContext) {
  const { isThemeRequest, themeFiles, fileSystem, syntaxPlugin, options } = loaderContext.data
  const { syntax, onlyColor } = options
  const extractOptions = { syntax, syntaxPlugin, onlyColor }
  const plugins = []

  if (!isThemeRequest) {
    plugins.push(
      // 抽取本地变量
      extractContextVarsPlugin(extractOptions)
    )
  }

  let importOptions: AtImportOptions | undefined
  if (!isThemeRequest) {
    importOptions = {
      load: async (filename) =>
        isThemeFile(filename, themeFiles)
          ? // 如果是对主题文件的导入，则对其进行变量抽取
            extractTopScopeVars(loaderContext, await readFile(filename, fileSystem), filename)
          : // 非主题文件，使用webpack缓存文件系统读取文件
            readFile(filename, fileSystem),
    }
  }

  plugins.push(
    // 获取通用处理插件， 主要是 atImport 插件
    ...getCommonPlugins(loaderContext, importOptions)
  )

  plugins.push(
    !isThemeRequest
      ? // 抽取全局可用变量
        extractVariablesPlugin(extractOptions)
      : // 抽取主题变量
        extractThemeVarsPlugin(extractOptions)
  )

  return plugins
}

// 定义上下文数据
function defineLoaderData(context: WebpackLoaderContext) {
  const { resourcePath, resourceQuery, data } = context
  const { token } = getQueryObject(resourceQuery)
  const options = getLoaderOptions(context)
  const { syntax, token: themeToken } = options
  const themeFiles = varsLoader.getThemeFiles!()

  // 定义上下文数据，只读，且不能被遍历，不能被删除
  return Object.defineProperties(data, {
    isStylesheet: {
      value: isStylesheet(resourcePath),
    },
    isThemeFile: {
      value: isThemeFile(resourcePath, themeFiles),
    },
    isThemeRequest: {
      value: token === themeToken,
    },
    syntaxPlugin: {
      value: getSyntaxPlugin(syntax),
    },
    themeFiles: {
      value: themeFiles,
    },
    fileSystem: {
      value: context.fs || fs,
    },
    options: {
      value: options,
    },
  }) as LoaderData
}

// pitch 阶段预处理，获取相关数据变量
export const pitch: PluginLoader['pitch'] = function () {
  if (!defineLoaderData(this).isStylesheet) {
    this.callback(null)
    return
  }
  const callback = this.async() || (() => {})
  // run pitch
  ;(async () => {
    //
    const loaderContext = this as LoaderContext
    const { resourcePath, data } = loaderContext
    const { fileSystem, isThemeFile, isThemeRequest, syntaxPlugin } = data
    const source = await readFile(resourcePath, fileSystem)

    if (isThemeFile) {
      if (!isThemeRequest) {
        // 由用户自己导入的主题文件
        // 抽取变量，替换样式文件
        return extractTopScopeVars(loaderContext, source, resourcePath)
      }
    }

    // 获取插件
    const plugins = getPostcssPlugins(loaderContext)

    // 预处理
    const { messages } = await postcss(plugins).process(source, {
      syntax: syntaxPlugin,
      from: resourcePath,
      map: false,
    })

    // 设置数据
    await setVarsData(loaderContext, messages)

    //
  })()
    // 执行回调
    .then((css: any) => (typeof css === 'string' ? callback(null, css) : callback(null)))
    .catch(callback)
}

// normal 阶段
const varsLoader: PluginLoader = function (source, map) {
  const loaderContext = this as LoaderContext
  const { data, resourcePath } = loaderContext
  const { isStylesheet, options, syntaxPlugin } = data
  const { syntax, onlyColor } = options

  if (!isStylesheet) {
    this.callback(null, source, map)
    return
  }

  const { themeMessages, variablesMessages, contextMessages } = data
  const callback = this.async() || (() => {})

  postcss([
    // 更新当前请求的css文件内容
    extractVarsPlugin({
      syntax,
      onlyColor,
      syntaxPlugin,
      themeMessages,
      variablesMessages,
      contextMessages,
    }),
  ])
    .process(source, {
      syntax: syntaxPlugin,
      from: resourcePath,
      map: false,
    })
    .then(({ css }) => callback(null, css))
    .catch(callback)
}

varsLoader.filepath = __filename
varsLoader.pitch = pitch
export default varsLoader
