import * as path from 'path'
import type {
  Compiler,
  Configuration,
  Logger,
  Output as WebpackOutput,
  Plugin as WebpackPlugin,
  RuleSetLoader,
  RuleSetRule,
  RuleSetUseItem,
} from 'webpack'
import { findLoader, hasRuleConditions, isCssRule } from '@ices/use-loader'
import {
  getQueryObject,
  getQueryString,
  isSamePath,
  normalizeRelativePath,
  normalModuleRegx,
  themeRequestToken,
} from './lib/utils'
import { getOptions, PluginOptions, ValidPluginOptions } from './options'
import { ThemeModule } from './ThemeModule'
import varsLoader, { VarsLoaderOptions } from './loaders/varsLoader'
import chunkLoader from './loaders/chunkLoader'
import extractLoader from './loaders/extractLoader'
import scopeLoader from './loaders/scopeLoader'
import moduleLoader from './loaders/moduleLoader'

type WebpackLoader = import('webpack').loader.Loader
type WebpackLoaderContext = import('webpack').loader.LoaderContext
type WebpackLoaderCallback = import('webpack').loader.loaderCallback
type CompilerOutput = NonNullable<WebpackOutput>

export interface LoaderContext extends WebpackLoaderContext {
  callback(
    err: Error | undefined | null,
    content?: string | Buffer,
    sourceMap?: Parameters<WebpackLoaderCallback>[2],
    meta?: any
  ): ReturnType<WebpackLoaderCallback>
  async(): LoaderContext['callback'] | undefined
}

export interface PluginLoader {
  (
    this: LoaderContext,
    source: string | Buffer,
    map: Parameters<WebpackLoader>[1],
    meta: any
  ): ReturnType<WebpackLoader>
  pitch?: WebpackLoader['pitch']
  raw?: WebpackLoader['raw']
  filepath: string
  getThemeFiles?: () => string[]
  getPluginOptions?: () => ValidPluginOptions
  getCompilerOptions?: () => CompilerOptions
}

export type CompilerOptions = {
  readonly output: CompilerOutput
}

//
class ThemePlugin implements WebpackPlugin {
  private readonly options: ValidPluginOptions
  private compilerOutput: CompilerOutput = {}
  private logger: Logger | null = null

  constructor(opts?: PluginOptions) {
    this.options = getOptions(opts)
  }

  // 使用 webpack 插件
  apply(compiler: Compiler) {
    const { options: compilerOptions } = compiler
    const { mode, output } = compilerOptions
    const pluginName = ThemePlugin.name
    const isEnvProduction = mode !== 'development' || process.env.NODE_ENV !== 'development'
    this.compilerOutput = Object.assign({}, output)

    if (typeof compiler.getInfrastructureLogger === 'function') {
      this.logger = compiler.getInfrastructureLogger(pluginName)
    }

    const themeModule = new ThemeModule(this.options, this.logger)

    this.injectLoaderMethod(themeModule)
    this.applyVarsLoaders(compilerOptions)

    compiler.hooks.normalModuleFactory.tap(pluginName, (factory) =>
      factory.hooks.beforeResolve.tap(pluginName, (module) => this.resolveStyleModule(module))
    )
    compiler.hooks.run.tapPromise(pluginName, async (compiler) =>
      themeModule.create(compiler.context || process.cwd(), false)
    )
    compiler.hooks.watchRun.tapPromise(pluginName, async (compiler) =>
      themeModule.create(compiler.context || process.cwd(), !isEnvProduction)
    )
  }

  // 是否处理style模块解析，该方法静态导出，如果有需要hack，可以覆写此方法自行定义
  static shouldResolveStyleModule(resourcePath: string, resourceQuery: string) {
    return !!resourceQuery && !normalModuleRegx.test(resourcePath)
  }

  // 解析style资源模块
  private resolveStyleModule(module: any) {
    const { isStyleModule } = this.options
    let { request, context, contextInfo = {} } = module || {}
    let resourcePath = request.split('!').pop()!.replace(/\?.*/, '')
    const resourceQuery = getQueryString(request)
    if (typeof context !== 'string') {
      context = ''
    }
    if (context && !path.isAbsolute(resourcePath)) {
      resourcePath = path.join(context, resourcePath)
    }
    const loaderPath = context
      ? normalizeRelativePath(moduleLoader.filepath, context)
      : moduleLoader.filepath
    if (
      typeof request !== 'string' ||
      request
        .split('!')
        .slice(0, -1)
        .some((file) => isSamePath(file.replace(/\?.*/, ''), loaderPath)) ||
      !ThemePlugin.shouldResolveStyleModule(resourcePath, resourceQuery)
    ) {
      return
    }
    const res = isStyleModule({
      query: getQueryObject(resourceQuery),
      issuer: contextInfo?.issuer || '',
      resourcePath,
      resourceQuery,
      request,
      context,
    })
    if (!res) {
      return
    }
    const syntax = typeof res === 'boolean' ? 'auto' : res
    const options = [`syntax=${encodeURIComponent(syntax)}`]
    module.request = `!!${loaderPath}?${options.join('&')}!${request}`
  }

  // 注入插件方法到内部loader
  // 注入插件方法到内部loaders
  private injectLoaderMethod(themeModule: ThemeModule) {
    for (const [name, method] of [
      ['getThemeFiles', () => [...themeModule.themeFiles.values()]],
      ['getPluginOptions', () => ({ ...this.options })],
      ['getCompilerOptions', () => ({ output: { ...this.compilerOutput } })],
    ]) {
      for (const loader of [varsLoader, scopeLoader, extractLoader, chunkLoader, moduleLoader]) {
        ;(loader as any)[name as string] = method
      }
    }
  }

  // 应用loader
  private applyLoaders(
    compilerOptions: Configuration,
    matchRule: (rule: RuleSetRule) => boolean,
    getThemeLoaders: (rule: RuleSetRule, parent: RuleSetRule | null) => RuleSetUseItem[]
  ) {
    const loaders = findLoader(
      compilerOptions,
      ({ siblings, index, isUseItem, rule, name }) => {
        if (name !== 'file-loader' && matchRule(rule)) {
          return !isUseItem || index === siblings.length - 1
        }
        return false
      },
      (rule) => matchRule(rule)
    )
    for (const { rule, parent, siblings, isUseItem } of loaders) {
      const themeLoaders = getThemeLoaders(rule, parent)
      if (isUseItem) {
        siblings.push(...themeLoaders)
      } else {
        const { use, loader, loaders, options, query } = rule
        rule.use = [
          {
            query,
            options,
            loader: use || loader || loaders,
          } as RuleSetUseItem,
          ...themeLoaders,
        ]
        delete rule.loader
        delete rule.loaders
        delete rule.options
      }
    }
  }

  // 变量loader用于抽离样式文件中与主题相关的样式属性变量
  private applyVarsLoaders(compilerOptions: Configuration) {
    this.applyLoaders(
      compilerOptions,
      (rule) => isCssRule(rule),
      (rule, parent) => this.getThemeVarsLoaders(rule, parent)
    )
    // 重设css-loader的importLoaders值
    for (const { siblings, index } of findLoader(compilerOptions, 'css-loader')) {
      const loader = siblings[index] as RuleSetLoader
      loader.options = Object.assign({}, loader.options, {
        importLoaders: siblings.length - index - 1,
      })
    }
  }

  // 获取处理主题的loader
  private getThemeVarsLoaders(rule: RuleSetRule, parent: RuleSetRule | null) {
    let syntax
    if (parent && hasRuleConditions(parent)) {
      rule = parent
    }
    if (isCssRule(rule, { syntax: 'scss' })) {
      syntax = 'scss'
    } else if (isCssRule(rule, { syntax: 'less' })) {
      syntax = 'less'
    } else if (isCssRule(rule, { syntax: 'sass' })) {
      syntax = 'sass'
    } else {
      syntax = 'css'
    }

    const { onlyColor, extract, themeAttrName } = this.options
    const loaders: RuleSetUseItem[] = []
    const options = {
      token: themeRequestToken,
      onlyColor,
      syntax,
    } as VarsLoaderOptions

    if (!extract) {
      loaders.push({
        loader: scopeLoader.filepath,
        options: { ...options, themeAttrName },
      })
    }

    loaders.push({
      loader: varsLoader.filepath,
      options: { ...options },
    })

    return loaders
  }
}

export default ThemePlugin
