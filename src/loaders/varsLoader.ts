import * as fs from 'fs'
import * as path from 'path'
import type { AcceptedPlugin, Message, Syntax } from 'postcss'
import postcss, { Root } from 'postcss'
import type { AtImportOptions } from 'postcss-import'
import atImport from 'postcss-import'
import { getOptions } from 'loader-utils'
import { ThemeVarsMessage } from '../lib/postcss/variables'
import { LoaderContext as WebpackLoaderContext, PluginLoader } from '../ThemePlugin'
import { getVarsMessages, PluginMessages } from '../lib/postcss/tools'
import { resolveStyle } from '../lib/resolve'
import {
  createASTMeta,
  getQueryObject,
  getResultSourceMap,
  getSourceMapOptions,
  getSupportedSyntax,
  getSyntaxPlugin,
  isSamePath,
  isStylesheet,
  readFile,
  SupportedSyntax,
  tryGetCodeIssuerFile,
} from '../lib/utils'
import {
  defineContextVarsPlugin,
  defineThemeVariablesPlugin,
  defineURLVarsPlugin,
  mergeThemeFileVarsPlugin,
  preserveRawStylePlugin,
  replaceWithThemeVarsPlugin,
  resolveContextVarsPlugin,
  resolveImportPlugin,
} from '../lib/postcss/plugins'

export interface VarsLoaderOptions {
  syntax: SupportedSyntax
  onlyColor: boolean
  token: string
  isStyleModule?: boolean
  themeAttrName?: string
}

interface LoaderData extends PluginMessages {
  readonly options: VarsLoaderOptions
  readonly themeFiles: string[]
  readonly isStylesheet: boolean
  readonly isStyleModule: boolean
  readonly isThemeFile: boolean
  readonly isThemeRequest: boolean
  readonly syntaxPlugin: Syntax
  readonly fileSystem: typeof fs
  readonly uriMaps: Map<string, Map<string, string>>
  readonly astMaps: Map<string, Root>
}

interface LoaderContext extends WebpackLoaderContext {
  readonly data: LoaderData
}

// 判断是不是主题文件
function isThemeStyleFile(file: string, themeFiles: string[]) {
  return themeFiles.some((theme) => isSamePath(file, theme))
}

// 判断是不是依赖的主题文件
function isThemeDependency({ type, plugin, file }: Message, themeFiles: string[]) {
  return type === 'dependency' && plugin === 'postcss-import' && isThemeStyleFile(file, themeFiles)
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
  const { options, syntaxPlugin, fileSystem, astMaps } = loaderContext.data
  const { syntax, onlyColor } = options
  const pluginOptions = { syntax, syntaxPlugin, onlyColor }
  const themeVars = new Map<string, ThemeVarsMessage>()

  for (const file of themeDependencies) {
    const source = await readFile(file, fileSystem)
    // 处理主题文件
    const { messages, root } = await postcss([
      //
      ...getCommonPlugins(loaderContext, false),
      defineThemeVariablesPlugin(pluginOptions),
      //
    ]).process(source, {
      syntax: syntaxPlugin,
      from: file,
      to: file,
      map: false,
    })

    // 保存主题文件的语法树，后面合并主题文件时需要用到
    astMaps.set(file, root)

    // 合并数据
    getThemeVarsMessages(messages, themeVars)
  }

  return [...themeVars.values()]
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
          const uriMap = uriMaps.get(sourceFile)!
          if (uriMap.has(id)) {
            return uriMap.get(id)
          }
          const file = await resolveStyle(resolve, id, syntax, context)
          if (
            isSamePath(sourceFile, resourcePath) &&
            !isThemeStyleFile(resourcePath, themeFiles) &&
            !isThemeStyleFile(file, themeFiles)
          ) {
            // 如果是被loader处理的资源文件，其中导入的是要是主题文件，才进行处理
            return
          }
          uriMap.set(id, file)
          // 添加依赖文件
          loaderContext.addDependency(file)
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
  importOptions: AtImportOptions = {}
): AcceptedPlugin[] {
  const { rootContext, data } = loaderContext
  const { options, fileSystem, syntaxPlugin, astMaps } = data
  const { syntax, onlyColor } = options
  const { plugins: atImportPlugins = [], ...restImportOptions } = importOptions
  const { plugin: resolveImportPlugin, filter, resolve } = getResolveImportPlugin(loaderContext)
  const pluginOptions = { syntax, syntaxPlugin, onlyColor }

  return [
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
        !mergeThemeFile
          ? defineURLVarsPlugin(pluginOptions)
          : mergeThemeFileVarsPlugin({ ...pluginOptions, astMaps }),
        ...atImportPlugins,
      ],

      load: async (filename: string) => readFile(filename, fileSystem),
      ...restImportOptions,
      //
    } as AtImportOptions),
  ] as AcceptedPlugin[]
}

// 获取配置对象
function getLoaderOptions(loaderContext: WebpackLoaderContext) {
  const options = getOptions(loaderContext) as any
  return {
    ...options,
    syntax: getSupportedSyntax(options.syntax, loaderContext.resourcePath),
  } as VarsLoaderOptions
}

// 获取pitch阶段的处理插件
function getPluginsForPitchStage(loaderContext: LoaderContext) {
  const { isThemeRequest, syntaxPlugin, options } = loaderContext.data
  const { syntax, onlyColor } = options
  const pluginOptions = { syntax, syntaxPlugin, onlyColor }
  const plugins = []

  if (!isThemeRequest) {
    plugins.push(defineContextVarsPlugin(pluginOptions))
  }

  plugins.push(...getCommonPlugins(loaderContext, false))

  plugins.push(
    !isThemeRequest
      ? resolveContextVarsPlugin(pluginOptions)
      : defineThemeVariablesPlugin(pluginOptions)
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

  plugins.push(...getCommonPlugins(loaderContext, !isThemeFile))

  plugins.push(
    replaceWithThemeVarsPlugin({
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
  const { token: queryToken } = getQueryObject(resourceQuery)
  const options = getLoaderOptions(context)
  const { syntax, token, isStyleModule } = options
  const themeFiles = varsLoader.getThemeFiles!()
  const isThemeFile = isThemeStyleFile(resourcePath, themeFiles)

  // 定义上下文数据，只读，且不能被遍历，不能被删除
  return Object.defineProperties(data, {
    isStylesheet: {
      value: isStylesheet(resourcePath),
    },
    isStyleModule: {
      value: !!isStyleModule,
    },
    isThemeFile: {
      value: isThemeFile,
    },
    isThemeRequest: {
      value: isThemeFile && token === queryToken,
    },
    syntaxPlugin: {
      value: getSyntaxPlugin(syntax, resourcePath),
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
      value: new Map([[resourcePath, new Map()]]),
    },
    astMaps: {
      value: new Map(),
    },
  }) as LoaderData
}

// 预处理
async function preProcess(loaderContext: LoaderContext, source: string) {
  const { resourcePath, data } = loaderContext
  const { syntaxPlugin } = data
  const processor = postcss(getPluginsForPitchStage(loaderContext))
  const { messages } = await processor.process(source, {
    syntax: syntaxPlugin,
    from: resourcePath,
    to: resourcePath,
    map: false,
  })
  await setVarsData(loaderContext, messages)
}

// pitch 阶段预处理，获取相关数据变量
export const pitch: PluginLoader['pitch'] = function () {
  const { isStyleModule, isStylesheet, fileSystem, isThemeFile, isThemeRequest } = defineLoaderData(
    this
  )

  if (isThemeFile && !isThemeRequest) {
    // 不允许从用户代码里直接导入主题文件，因为主题文件是要转换为动态加载的chunk的
    const issuer = tryGetCodeIssuerFile(this._module)
    const err = new Error(
      `You are importing a theme file from the code${
        issuer ? ` in '${path.relative(this.rootContext, issuer)}'` : ''
      }.\nThe theme file should only be imported and processed by the theme lib and style file.\nMost of the time, it is used as a variable declaration file.`
    )
    err.stack = undefined
    this.callback(err)
    return
  }

  if (isStyleModule || !isStylesheet) {
    this.callback(null)
    return
  }

  const loaderContext = this as LoaderContext
  const callback = this.async() || (() => {})

  readFile(this.resourcePath, fileSystem)
    .then((source) => preProcess(loaderContext, source))
    .then(() => callback(null))
    .catch(callback)
}

// normal 阶段
const varsLoader: PluginLoader = function (source, map, meta) {
  const loaderContext = this as LoaderContext
  const { data, resourcePath } = loaderContext
  const { isStylesheet, isStyleModule, isThemeFile, syntaxPlugin, uriMaps } = data

  if (!isStylesheet && !isStyleModule) {
    this.callback(null, source, map, meta)
    return
  }

  const callback = this.async() || (() => {})

  ;(async () => {
    if (Buffer.isBuffer(source)) {
      source = source.toString('utf8')
    }
    if (isStyleModule) {
      await preProcess(loaderContext, source)
    }
    if (!isThemeFile && !uriMaps.get(resourcePath)!.size) {
      callback(null, source, map, meta)
      return
    }

    const plugins = getPluginsForNormalStage(loaderContext)
    const result = await postcss(plugins).process(source, {
      syntax: syntaxPlugin,
      from: resourcePath,
      to: resourcePath,
      map: getSourceMapOptions(this, map),
    })

    const { css, map: resultMap, root, messages, processor } = result
    callback(
      null,
      css,
      getResultSourceMap(this, resultMap),
      createASTMeta({ root, messages, version: processor.version }, meta)
    )
    //
  })().catch(callback)
}

varsLoader.filepath = __filename
varsLoader.pitch = pitch
export default varsLoader
