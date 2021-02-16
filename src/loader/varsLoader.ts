import * as fs from 'fs'
import type { AcceptedPlugin, Message, Syntax } from 'postcss'
import postcss from 'postcss'
import type { AtImportOptions } from 'postcss-import'
import atImport from 'postcss-import'
import { getOptions } from 'loader-utils'
import { PluginLoader } from '../Plugin'
import { selfModuleName } from '../lib/selfContext'
import {
  getQueryObject,
  getValidSyntax,
  isSamePath,
  isStylesheet,
  normalizeSourceMap,
  readFile,
} from '../lib/utils'
import { ThemeLoaderData, ThemeVarsMessage } from '../lib/postcss/tools'
import { getVarsMessages } from '../lib/postcss/helper'
import {
  exportVarsPlugin,
  extractContextVarsPlugin,
  extractThemeVarsPlugin,
  extractTopScopeVarsPlugin,
  extractURLVars,
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

// 判断是不是主题文件
function isThemeFile(file: string, themeFiles: string[]) {
  return themeFiles.some((theme) => isSamePath(file, theme))
}

// 判断是不是依赖的主题文件
function isThemeDependency({ type, plugin, file }: Message, themeFiles: string[]) {
  return type === 'dependency' && plugin === 'postcss-import' && isThemeFile(file, themeFiles)
}

// 从消息中筛选依赖的主题文件
function getThemeDependencies(messages: Message[], themeFiles: string[]) {
  return messages.filter((msg) => isThemeDependency(msg, themeFiles)).map(({ file }) => file)
}

// 从消息中筛选当前样式文件的本地变量
function getContextMessages(messages: Message[]) {
  return getVarsMessages(messages, 'theme-context-vars')
}

// 从消息中筛选主题变量
function getThemeVarsMessages(
  messages: Message[],
  themeVars: Map<string, ThemeVarsMessage> = new Map<string, ThemeVarsMessage>()
) {
  // 合并变量
  for (const msg of getVarsMessages(messages, 'theme-root-vars')) {
    themeVars.set(msg.ident, msg)
  }
  for (const msg of getVarsMessages(messages, 'theme-vars')) {
    themeVars.set(msg.ident, msg)
  }
  return [...themeVars.values()]
}

// 从消息中筛选URL变量
function getURLVarsMessages(messages: Message[]) {
  const varsMap = new Map<string, ThemeVarsMessage>()
  for (const vars of getVarsMessages(messages, ({ type }) => type === 'theme-url-vars')) {
    // 由于存在文件导入，这里去重下（顺序不能变，后面的覆盖前面的）
    varsMap.set(vars.ident, vars)
  }
  return [...varsMap.values()]
}

// 获取语法插件模块
function getSyntaxPlugin(syntax: string) {
  return require(`postcss-${syntax === 'css' ? 'safe-parser' : syntax}`) as Syntax
}

// 设置变量数据，这些数据在theme-loader的normal阶段使用
// 这里的入参消息列表messages，里面是当前文件中所有的解析消息
// 其中，包含导入文件依赖，主题文件中的所有变量（包含主题变量以及非主题变量），自身的本地变量，以及非主题文件的所有导入变量
async function setVarsData(loaderContext: LoaderContext, messages: Message[]) {
  const { data } = loaderContext
  const { isThemeRequest } = data

  if (!isThemeRequest) {
    // 用于在当前样式文件中，替换引用自主题文件的变量声明

    // 获取当前文件所处解析上下文中，所有由被导入的主题文件所导出的主题变量（排除掉了不能用作主题变量的变量）
    // 需要在所有文件导入完成后进行，不然解析变量可能存在解析不到的情况（依赖了导入文件中的变量，而那个文件还没有处理的时候）
    data.variablesMessages = await getVariablesMessages(loaderContext, messages)
    // 获取当前文件自身声明的本地变量
    data.contextMessages = getContextMessages(messages)
  } else {
    // 用于生成单独的主题文件变量

    // 获取主题文件所处解析上下文中，由主题文件导出的主题变量（排除掉了不能用作主题变量的变量）
    data.themeMessages = getThemeVarsMessages(messages)
  }
  // 用于对导入文件中的外部资源引用进行相对路径修正
  // 这里的url消息包含了所有的url资源引用变量声明，处理值替换时，值处理器只会处理需要处理的变量声明，所以这里不需要做过滤
  data.urlMessages = getURLVarsMessages(messages)
}

// 获取来自于主题文件导出的主题变量（排除掉了不能用作主题变量的变量）
// 需要在所有导入完成后执行，不然会丢变量
async function extractThemeVars(loaderContext: LoaderContext, themeDependencies: string[]) {
  const { options, syntaxPlugin, fileSystem } = loaderContext.data
  const { syntax, onlyColor } = options
  const extractOptions = { syntax, syntaxPlugin, onlyColor }
  const themeVars = new Map<string, ThemeVarsMessage>()

  for (const file of themeDependencies) {
    // 一般只有一个主题依赖文件，即只需要导入一个默认主题文件获取变量声明即可
    // 如果导入了多个主题文件，则由这些主题文件导出的变量，在当前解析上下文中都可用
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

    // 合并数据
    getThemeVarsMessages(messages, themeVars)
  }

  return [...themeVars.values()]
}

// 获取可用的主题变量（排除掉了不能用作主题变量的变量）
async function getVariablesMessages(loaderContext: LoaderContext, messages: Message[]) {
  const { themeFiles } = loaderContext.data
  return extractThemeVars(loaderContext, getThemeDependencies(messages, themeFiles))
}

// 获取通用插件模块
function getCommonPlugins(loaderContext: LoaderContext, importOptions: AtImportOptions = {}) {
  const { rootContext, resolve, data } = loaderContext
  const { options, fileSystem, syntaxPlugin } = data
  const { syntax, cssModules, onlyColor } = options
  const { plugins: importPlugins = [], ...restImportOptions } = importOptions
  //
  const plugins = [
    atImport({
      root: rootContext,
      skipDuplicates: true,
      // 抽取URL变量，导入的URL变量，如果是相对路径，不作处理，会有问题
      // 本应该由相应语言loader自己处理路径转换的，但不知为啥没有处理
      // 关于这个问题，resolve-url-loader 有专门的说明，并且提供一种通过sourceMap来解决的方案
      plugins: [extractURLVars({ syntax, syntaxPlugin, onlyColor }), ...importPlugins],
      // 使用webpack的缓存文件系统读取文件
      load: (filename: string) => readFile(filename, fileSystem),
      // 这里resolve要使用webpack的resolve模块，webpack可能配置了resolve别名等
      resolve: (id: string, basedir: string) => resolveStyle(resolve, id, syntax, basedir),
      ...restImportOptions,
    } as AtImportOptions),
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
  const { variablesMessages, urlMessages } = await postcss([
    ...getCommonPlugins(loaderContext),
    extractTopScopeVarsPlugin({ ...extractOptions }),
  ])
    .process(source, {
      syntax: syntaxPlugin,
      from: filename,
      map: false,
    })
    .then(({ messages }) => ({
      // 被导入的变量消息（包含能用做主题变量的声明以及常规变量声明）
      variablesMessages: getThemeVarsMessages(messages),
      // 被导入的内容中包含的外部资源引用，如果是相对地址，需要进行路径重写，要用到这些值
      urlMessages: getURLVarsMessages(messages),
    }))

  //
  return (
    await postcss([
      exportVarsPlugin({ ...extractOptions, urlMessages, variablesMessages }),
    ]).process(`/* Theme Variables extracted by ${selfModuleName} */\n\n`, {
      syntax: syntaxPlugin,
      from: filename,
      map: false,
    })
  ).css
}

// 获取配置对象
function getLoaderOptions(loaderContext: WebpackLoaderContext) {
  const { ...options } = getOptions(loaderContext) as any
  options.syntax = getValidSyntax(options.syntax)
  return options as VarsLoaderOptions
}

// 获取插件列表
function getPitchPostcssPlugins(loaderContext: LoaderContext) {
  const { isThemeRequest, syntaxPlugin, options } = loaderContext.data
  const { syntax, onlyColor } = options
  const extractOptions = { syntax, syntaxPlugin, onlyColor }
  const plugins = []

  if (!isThemeRequest) {
    plugins.push(
      // 抽取本地变量
      extractContextVarsPlugin(extractOptions)
    )
  }

  plugins.push(
    // 获取通用处理插件， 主要是 atImport 插件
    ...getCommonPlugins(loaderContext)
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
        // 由用户自己导入的主题文件（从js代码里引用）
        // 抽取变量，替换样式文件
        return extractTopScopeVars(loaderContext, source, resourcePath)
      }
    }

    // 获取插件
    const plugins = getPitchPostcssPlugins(loaderContext)

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
  const { data, resourcePath, sourceMap } = loaderContext
  const { isStylesheet, options, syntaxPlugin } = data
  const { syntax, onlyColor } = options

  if (!isStylesheet) {
    this.callback(null, source, map)
    return
  }

  const { urlMessages, themeMessages, variablesMessages, contextMessages } = data
  const useSourceMap =
    sourceMap && syntax !== 'less'
      ? // less 解析器在进行序列化时，报sourceMap错误
        { prev: normalizeSourceMap(map, resourcePath) || null, inline: false, annotation: false }
      : false

  const callback = this.async() || (() => {})

  postcss([
    // 更新当前请求的css文件内容
    extractVarsPlugin({
      syntax,
      onlyColor,
      syntaxPlugin,
      urlMessages,
      themeMessages,
      variablesMessages,
      contextMessages,
    }),
  ])
    .process(source, {
      syntax: syntaxPlugin,
      from: resourcePath,
      to: resourcePath,
      map: useSourceMap,
    })
    .then(({ css, map }) => callback(null, css, map ? map.toJSON() : undefined))
    .catch((err) => {
      if (err.file) {
        this.addDependency(err.file)
      }
      callback(err)
    })
}

varsLoader.filepath = __filename
varsLoader.pitch = pitch
export default varsLoader
