import type { Message, Syntax } from 'postcss'
import postcss from 'postcss'
import type { AtImportOptions } from 'postcss-import'
import * as fs from 'fs'
import { getOptions, parseQuery } from 'loader-utils'
import { PluginLoader } from '../Plugin'
import {
  formatSourceMap,
  getCommonPlugins,
  getRawSourceMap,
  getValidSyntax,
  isSamePath,
  isStylesheet,
  readFile,
} from '../lib/utils'
import { setRefVars, ThemeLoaderData, ThemeVarsMessage } from '../lib/postcss/tools'
import { getVarsMessages } from '../lib/postcss/helper'
import {
  exportVarsPlugin,
  extractContextVarsPlugin,
  extractThemeVarsPlugin,
  extractTopScopeVarsPlugin,
  extractVariablesPlugin,
  extractVarsPlugin,
} from '../lib/postcss/plugins'

export interface VarsLoaderOptions {
  sourceMap: boolean | string
  cssModules: boolean
  onlyColor: boolean
  syntax: string
  token: string
  getThemeFiles: () => string[]
}

type LoaderContext = import('webpack').loader.LoaderContext
type themeLoaderVariablesData = ThemeLoaderData['themeLoaderVariablesData']
type themeLoaderContextData = ThemeLoaderData['themeLoaderContextData']
type themeLoaderThemeData = ThemeLoaderData['themeLoaderThemeData']

function setThemeData(variablesMessages: ThemeVarsMessage[], data: ThemeLoaderData) {
  const variablesData: themeLoaderThemeData = (data.themeLoaderThemeData = {})
  for (const { name, originalValue } of variablesMessages) {
    variablesData[name] = originalValue
  }
}

async function setVarsData(
  variablesMessages: ThemeVarsMessage[],
  contextMessages: ThemeVarsMessage[],
  data: ThemeLoaderData
) {
  // 主题文件中导入的变量
  const variablesData: themeLoaderVariablesData = (data.themeLoaderVariablesData = {})
  for (const { name, value } of variablesMessages) {
    variablesData[name] = value
  }

  // 当前文件中的变量
  const contextData: themeLoaderContextData = (data.themeLoaderContextData = {})
  for (const msg of contextMessages) {
    const { name, value, dependencies } = msg
    // 如果本地变量的依赖变量全部来自主题变量，则认为该变量实际是对主题变量的间接引用
    if (
      dependencies?.length &&
      dependencies.every((name) => typeof variablesData[name] === 'string' && variablesData[name])
    ) {
      setRefVars(variablesData, msg)
    }

    contextData[name] = value
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
async function extractThemeVars(
  loaderContext: LoaderContext,
  themeFiles: string[],
  options: VarsLoaderOptions
) {
  const { syntax, cssModules, onlyColor } = options
  const themeVars = new Map<string, ThemeVarsMessage>()
  // 迭代顺序不能变，这里按照导入顺序，有前后同名变量覆盖存在
  for (const file of themeFiles) {
    const syntaxPlugin = require(`postcss-${syntax === 'css' ? 'safe-parser' : syntax}`) as Syntax
    const source = await readFile(file, loaderContext.fs || fs)
    // 处理主题文件
    const { messages } = await postcss([
      ...getCommonPlugins(loaderContext, syntax, cssModules),
      extractThemeVarsPlugin({ syntax, syntaxPlugin, onlyColor }),
    ]).process(source, {
      syntax: syntaxPlugin,
      from: file,
      map: false,
    })
    // 合并变量
    // name是ident
    // 这里value是解析后的真实值，可作为上下文数据被loader再次使用
    for (const msg of getVarsMessages(messages, 'theme-root-vars')) {
      themeVars.set(msg.name, msg)
    }
    for (const msg of getVarsMessages(messages, 'theme-vars')) {
      themeVars.set(msg.name, msg)
    }
  }
  // 转换为数组
  return [...themeVars.values()]
}

// 获取可用的全局变量
async function getVariablesMessages(
  loaderContext: LoaderContext,
  messages: Message[],
  themeFiles: string[],
  options: VarsLoaderOptions
) {
  return extractThemeVars(loaderContext, getThemeDependencies(messages, themeFiles), options)
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

// 抽取变量并返回样式定义
async function extractTopScopeVars(
  loaderContext: LoaderContext,
  source: string,
  syntaxPlugin: Syntax,
  options: VarsLoaderOptions
) {
  const { syntax, onlyColor, cssModules } = options
  // 提取变量
  const messages = await postcss([
    ...getCommonPlugins(loaderContext, syntax, cssModules),
    // 抽取顶级作用域变量
    extractTopScopeVarsPlugin({ syntax, syntaxPlugin, onlyColor, parseValue: false }),
  ])
    .process(source, {
      syntax: syntaxPlugin,
      from: loaderContext.resourcePath,
      map: false,
    })
    .then(({ messages }) => getThemeVarsMessages(messages))

  // 生成一个新的文件
  return (
    await postcss([exportVarsPlugin({ syntax, syntaxPlugin, onlyColor, messages })]).process(
      '/* Theme Variables extracted by @ices/theme-webpack-plugin */\n\n',
      {
        syntax: syntaxPlugin,
        from: undefined,
        map: false,
      }
    )
  ).css
}

// 获取配置对象
function getLoaderOptions(loaderContext: LoaderContext) {
  const { ...options } = (getOptions(loaderContext) as unknown) as VarsLoaderOptions
  options.syntax = getValidSyntax(options.syntax)
  return options
}

// pitch 阶段预处理，获取相关数据变量
const pitch: PluginLoader['pitch'] = function (remaining, preceding, data) {
  const { resourcePath, resourceQuery } = this

  Object.defineProperty(data, 'isStylesheet', {
    value: isStylesheet(resourcePath),
  })

  if (!data.isStylesheet) {
    this.callback(null)
    return
  }

  const options = getLoaderOptions(this)
  const { cssModules, onlyColor, getThemeFiles, syntax } = options
  const syntaxPlugin = getSyntaxPlugin(syntax)
  const themeFiles = getThemeFiles()
  const fileSystem = this.fs || fs
  const callback = this.async() || (() => {})

  Object.defineProperty(data, 'isThemeFile', {
    value: isThemeFile(resourcePath, themeFiles),
  })

  // run
  ;(async () => {
    //
    const source = await readFile(resourcePath, fileSystem)
    let isThemeModuleRequest

    if (data.isThemeFile) {
      const { token } = parseQuery(resourceQuery)
      isThemeModuleRequest = token === options.token
      if (!isThemeModuleRequest) {
        // 由用户自己导入的主题文件
        // 抽取变量，替换样式文件
        return extractTopScopeVars(this, source, syntaxPlugin, options)
      }
    }

    const plugins = []

    if (!isThemeModuleRequest) {
      plugins.push(
        // 抽取本地变量
        extractContextVarsPlugin({ syntax, syntaxPlugin, onlyColor })
      )
    }

    let importOptions: AtImportOptions | undefined
    if (!isThemeModuleRequest) {
      importOptions = {
        load: async (filename) =>
          isThemeFile(filename, themeFiles)
            ? // 如果是对主题文件的导入，则对其进行变量抽取
              extractTopScopeVars(this, await readFile(filename, fileSystem), syntaxPlugin, options)
            : // 非主题文件，使用webpack缓存文件系统读取文件
              readFile(filename, fileSystem),
      }
    }
    plugins.push(
      // 获取通用处理插件， 主要是 atImport 插件
      ...getCommonPlugins(this, syntax, cssModules, importOptions)
    )

    plugins.push(
      !isThemeModuleRequest
        ? // 抽取全局可用变量
          extractVariablesPlugin({ syntax, syntaxPlugin, onlyColor })
        : // 抽取主题变量
          extractThemeVarsPlugin({ syntax, syntaxPlugin, onlyColor })
    )

    // 预处理
    const { messages } = await postcss(plugins).process(source, {
      syntax: syntaxPlugin,
      from: resourcePath,
      map: false,
    })

    // 设置数据
    if (!isThemeModuleRequest) {
      await setVarsData(
        await getVariablesMessages(this, messages, themeFiles, options),
        getContextMessages(messages),
        data
      )
    } else {
      setThemeData(getThemeVarsMessages(messages), data)
    }

    //
  })()
    // 执行回调
    .then((css: any) => (typeof css === 'string' ? callback(null, css) : callback(null)))
    .catch(callback)
}

// normal 阶段
const varsLoader: PluginLoader = function (source, map) {
  const { data, resourcePath } = this

  if (!data.isStylesheet) {
    this.callback(null, source, map)
    return
  }

  const { syntax, onlyColor, sourceMap } = getLoaderOptions(this)
  const syntaxPlugin = getSyntaxPlugin(syntax)
  const callback = this.async() || (() => {})

  const {
    themeLoaderThemeData,
    themeLoaderContextData,
    themeLoaderVariablesData,
  } = data as ThemeLoaderData

  postcss([
    // 更新当前请求的css文件内容
    extractVarsPlugin({
      syntax,
      syntaxPlugin,
      onlyColor,
      themeLoaderThemeData,
      themeLoaderContextData,
      themeLoaderVariablesData,
    }),
  ])
    .process(source, {
      syntax: syntaxPlugin,
      from: resourcePath,
      map: sourceMap
        ? { inline: sourceMap === 'inline', annotation: false, prev: getRawSourceMap(map) }
        : false,
    })
    .then(({ css, map }) => callback(null, css, formatSourceMap(map)))
    .catch(callback)
}

varsLoader.filepath = __filename
varsLoader.pitch = pitch
export default varsLoader
