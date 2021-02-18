import * as fs from 'fs'
import * as path from 'path'
import type { AcceptedPlugin, Message, Syntax } from 'postcss'
import postcss from 'postcss'
import type { AtImportOptions } from 'postcss-import'
import atImport from 'postcss-import'
import { getOptions } from 'loader-utils'
import { LoaderContext as WebpackLoaderContext, PluginLoader } from '../Plugin'
import { ThemeLoaderData, ThemeVarsMessage } from '../lib/postcss/tools'
import { getVarsMessages } from '../lib/postcss/helper'
import { resolveStyle } from '../lib/resolve'
import {
  createASTMeta,
  getQueryObject,
  getValidSyntax,
  isSamePath,
  isStylesheet,
  readFile,
  tryGetCodeIssuerFile,
} from '../lib/utils'
import {
  defineContextVarsPlugin,
  defineThemeVariablesPlugin,
  defineTopScopeVarsPlugin,
  defineURLVarsPlugin,
  makeThemeVarsDeclPlugin,
  makeTopScopeVarsDeclPlugin,
  preserveRawStylePlugin,
  resolveContextVarsPlugin,
  resolveImportPlugin,
} from '../lib/postcss/plugins'

export interface VarsLoaderOptions {
  cssModules: boolean | { [p: string]: any }
  onlyColor: boolean
  syntax: string
  token: string
}

interface LoaderData extends ThemeLoaderData {
  readonly options: VarsLoaderOptions
  readonly themeFiles: string[]
  readonly isStylesheet: boolean
  readonly isThemeFile: boolean
  readonly isThemeRequest: boolean
  readonly syntaxPlugin: Syntax
  readonly fileSystem: typeof fs
  readonly uriMaps: Map<string, Map<string, string>>
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
    varsMap.set(vars.ident, vars)
  }
  return [...varsMap.values()]
}

// 获取语法插件模块
function getSyntaxPlugin(syntax: string) {
  return require(`postcss-${syntax === 'css' ? 'safe-parser' : syntax}`) as Syntax
}

// 设置变量数据，这些数据在theme-loader的normal阶段使用
async function setVarsData(loaderContext: LoaderContext, messages: Message[]) {
  const { data } = loaderContext
  const { isThemeRequest, themeFiles } = data
  if (!isThemeRequest) {
    data.contextMessages = getContextMessages(messages)
    data.variablesMessages = await extractThemeVars(
      loaderContext,
      getThemeDependencies(messages, themeFiles)
    )
  } else {
    data.contextMessages = []
    data.variablesMessages = getThemeVarsMessages(messages)
  }
  data.urlMessages = getURLVarsMessages(messages)
}

// 需要在所有导入完成后执行，不然会丢变量
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
      ...getCommonPlugins(loaderContext, false, false),
      defineThemeVariablesPlugin(extractOptions),
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

// 抽取变量并返回样式定义规则
async function extractTopScopeVars(loaderContext: LoaderContext, source: string, filename: string) {
  const { syntaxPlugin, options } = loaderContext.data
  const { syntax, onlyColor } = options
  const extractOptions = { syntax, syntaxPlugin, onlyColor }

  const { variablesMessages, urlMessages } = await postcss([
    ...getCommonPlugins(loaderContext, false, false),
    defineTopScopeVarsPlugin({ ...extractOptions }),
  ])
    .process(source, {
      syntax: syntaxPlugin,
      from: filename,
      map: false,
    })
    .then(({ messages }) => ({
      urlMessages: getURLVarsMessages(messages),
      variablesMessages: getThemeVarsMessages(messages),
    }))

  const plugins = [
    makeTopScopeVarsDeclPlugin({ ...extractOptions, urlMessages, variablesMessages }),
  ]

  // 生成一个临时字符串文件嵌入到当前解析文件中
  return (
    await postcss(plugins).process('', {
      syntax: syntaxPlugin,
      from: filename,
      map: false,
    })
  ).css
}

// 解析导入的主题文件路径
function getResolveImportPlugin(loaderContext: LoaderContext) {
  const { resolve, data, resourcePath } = loaderContext
  const { options, uriMaps, syntaxPlugin, themeFiles } = data
  const { syntax, onlyColor } = options
  const pluginOptions = { syntax, syntaxPlugin, onlyColor }
  let currentSourceFile: string

  return {
    plugin: resolveImportPlugin({
      ...pluginOptions,
      resolve: async (id, sourceFile, context) => {
        try {
          currentSourceFile = sourceFile
          if (!uriMaps.has(sourceFile)) {
            uriMaps.set(sourceFile, new Map<string, string>())
          }
          const file = await resolveStyle(resolve, id, syntax, context)
          if (
            isSamePath(sourceFile, resourcePath) &&
            !isThemeFile(resourcePath, themeFiles) &&
            !isThemeFile(file, themeFiles)
          ) {
            // 如果是被loader处理的资源文件，其中导入的是要是主题文件，才进行处理
            return
          }
          uriMaps.get(sourceFile)!.set(id, file)
        } catch (e) {}
      },
    }),
    //
    filter: (id: string) => !!uriMaps.get(currentSourceFile)?.has(id),
    resolve: (id: string, basedir: string) => {
      if (isSamePath(path.dirname(currentSourceFile), basedir)) {
        return uriMaps.get(currentSourceFile)?.get(id)
      }
    },
  }
}

// 获取通用处理插件
function getCommonPlugins(
  loaderContext: LoaderContext,
  mergeThemeFile: boolean,
  allowCssModules: boolean,
  importOptions: AtImportOptions = {}
) {
  const { rootContext, data } = loaderContext
  const { options, fileSystem, syntaxPlugin, themeFiles } = data
  const { syntax, cssModules, onlyColor } = options
  const { plugins: atImportPlugins = [], ...restImportOptions } = importOptions
  const { plugin: resolveImportPlugin, filter, resolve } = getResolveImportPlugin(loaderContext)
  const pluginOptions = { syntax, syntaxPlugin, onlyColor }

  const plugins = [
    resolveImportPlugin,
    preserveRawStylePlugin(pluginOptions),
    atImport({
      filter,
      resolve,
      root: rootContext,
      skipDuplicates: true,

      plugins: [
        resolveImportPlugin,
        preserveRawStylePlugin(pluginOptions),
        defineURLVarsPlugin(pluginOptions),
        ...atImportPlugins,
      ],

      load: async (filename: string) =>
        mergeThemeFile && isThemeFile(filename, themeFiles)
          ? extractTopScopeVars(loaderContext, await readFile(filename, fileSystem), filename)
          : readFile(filename, fileSystem),

      ...restImportOptions,
      //
    } as AtImportOptions),
  ] as AcceptedPlugin[]

  if (allowCssModules && cssModules) {
    plugins.push(require('postcss-modules')(Object.assign({}, cssModules)))
  }

  return plugins
}

// 获取配置对象
function getLoaderOptions(loaderContext: WebpackLoaderContext) {
  const { ...options } = getOptions(loaderContext) as any
  options.syntax = getValidSyntax(options.syntax)
  return options as VarsLoaderOptions
}

// 获取pitch阶段的处理插件
function getPluginsForPitchStage(loaderContext: LoaderContext) {
  const { isThemeRequest, syntaxPlugin, options, isThemeFile } = loaderContext.data
  const { syntax, onlyColor } = options
  const extractOptions = { syntax, syntaxPlugin, onlyColor }
  const plugins = []

  if (!isThemeRequest) {
    plugins.push(defineContextVarsPlugin(extractOptions))
  }

  plugins.push(...getCommonPlugins(loaderContext, false, !isThemeFile))

  plugins.push(
    !isThemeRequest
      ? resolveContextVarsPlugin(extractOptions)
      : defineThemeVariablesPlugin(extractOptions)
  )

  return plugins
}

// 获取normal阶段的处理插件
function getPluginsForNormalStage(loaderContext: LoaderContext) {
  const { data } = loaderContext
  const { options, syntaxPlugin, isThemeFile } = data
  const { urlMessages, contextMessages, variablesMessages } = data as Required<LoaderData>
  const { syntax, onlyColor } = options
  const plugins = []

  if (!isThemeFile) {
    plugins.push(...getCommonPlugins(loaderContext, true, true))
  }

  plugins.push(
    makeThemeVarsDeclPlugin({
      syntax,
      onlyColor,
      isThemeFile,
      syntaxPlugin,
      urlMessages,
      contextMessages,
      variablesMessages,
    })
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
    uriMaps: {
      value: new Map(),
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
  //
  ;(async () => {
    const loaderContext = this as LoaderContext
    const { resourcePath, data, rootContext } = loaderContext
    const { fileSystem, isThemeFile, isThemeRequest, syntaxPlugin } = data
    const source = await readFile(resourcePath, fileSystem)

    if (isThemeFile) {
      if (!isThemeRequest) {
        // 不允许从用户代码里直接导入主题文件，因为主题文件是要转换为动态加载的chunk的
        const issuer = tryGetCodeIssuerFile(this._module)
        const err = new Error(
          `You are importing a theme file from the code${
            issuer ? ` in '${path.relative(rootContext, issuer)}'` : ''
          }.\nThe theme file should only be imported and processed by the theme lib and style file.\nMost of the time, it is used as a variable declaration file.`
        )
        err.stack = undefined
        throw err
      }
    }

    const processor = postcss(getPluginsForPitchStage(loaderContext))
    const { messages } = await processor.process(source, {
      syntax: syntaxPlugin,
      from: resourcePath,
      map: false,
    })

    await setVarsData(loaderContext, messages)
  })()
    // 执行回调
    .then((css: any) => (typeof css === 'string' ? callback(null, css) : callback(null)))
    .catch(callback)
}

// normal 阶段
const varsLoader: PluginLoader = function (source, map, meta) {
  const loaderContext = this as LoaderContext
  const { data, resourcePath } = loaderContext
  const { isStylesheet, syntaxPlugin } = data

  if (!isStylesheet) {
    this.callback(null, source, map, meta)
    return
  }

  const callback = this.async() || (() => {})
  postcss(getPluginsForNormalStage(loaderContext))
    .process(source, {
      syntax: syntaxPlugin,
      from: resourcePath,
      to: resourcePath,
      // 因为当前loader是最先执行的loader，且视情况仅对源码插入和替换了一些内容
      // 所以映射文件这里不处理，交给余下loader去处理
      map: false,
    })
    .then(({ css, root, messages, processor }) =>
      callback(
        null,
        css,
        undefined,
        createASTMeta({ root, messages, version: processor.version }, meta)
      )
    )
    .catch(callback)
}

varsLoader.filepath = __filename
varsLoader.pitch = pitch
export default varsLoader
