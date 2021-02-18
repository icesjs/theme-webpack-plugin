import type {
  Compiler,
  Configuration,
  Output as WebpackOutput,
  Plugin as WebpackPlugin,
  RuleSetLoader,
  RuleSetRule,
  RuleSetUseItem,
} from 'webpack'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'
import globby from 'globby'
import { findLoader, isCssRule } from '@ices/use-loader'
import { getFileThemeName, getToken, isSamePath, isStylesheet } from './lib/utils'
import varsLoader, { VarsLoaderOptions } from './loader/varsLoader'
import extractLoader from './loader/extractLoader'
import themeLoader from './loader/themeLoader'
import { getOptions, PluginOptions, resolveDefaultExportPath, ValidPluginOptions } from './options'

export type WebpackLoader = import('webpack').loader.Loader
type Logger = import('webpack').Logger
type CompilerOutput = NonNullable<WebpackOutput>

export type CompilerOptions = {
  readonly output: CompilerOutput
}

export interface PluginLoader extends WebpackLoader {
  filepath: string
  getThemeFiles?: () => string[]
  getPluginOptions?: () => ValidPluginOptions
  getCompilerOptions?: () => CompilerOptions
}

//
class ThemeWebpackPlugin implements WebpackPlugin {
  private readonly options: ValidPluginOptions
  private readonly themeFiles = new Set<string>()
  private readonly themeRequestToken = getToken()
  private compilerOutput: CompilerOutput = {}
  private logger: Logger | null = null

  constructor(opts?: PluginOptions) {
    this.options = getOptions(opts)

    // 注入插件方法到内部loader
    for (const [name, method] of [
      ['getThemeFiles', () => [...this.themeFiles.values()]],
      ['getPluginOptions', () => ({ ...this.options })],
      ['getCompilerOptions', () => ({ output: { ...this.compilerOutput } })],
    ]) {
      for (const loader of [varsLoader, extractLoader, themeLoader]) {
        ;(loader as any)[name as string] = method
      }
    }

    this.resetThemeModule()
  }

  // 使用 webpack 插件
  apply(compiler: Compiler) {
    const { options: compilerOptions } = compiler
    const { mode } = compilerOptions
    const isEnvProduction = mode !== 'development' || process.env.NODE_ENV !== 'development'
    const pluginName = ThemeWebpackPlugin.name
    this.compilerOutput = Object.assign({}, compilerOptions.output)
    if (typeof compiler.getInfrastructureLogger === 'function') {
      this.logger = compiler.getInfrastructureLogger(pluginName)
    }

    this.applyVarsLoader(compilerOptions)

    compiler.hooks.run.tapPromise(pluginName, async (compiler) =>
      this.createThemeModule(compiler.context || compilerOptions.context || process.cwd(), false)
    )
    compiler.hooks.watchRun.tapPromise(pluginName, async (compiler) =>
      this.createThemeModule(
        compiler.context || compilerOptions.context || process.cwd(),
        !isEnvProduction
      )
    )
  }

  // 创建主题模块
  private async createThemeModule(context: string, watchMode: boolean) {
    const { defaultTheme, themeExportPath } = this.options
    const themeFiles = await this.getThemeFiles(context)
    if (
      this.themeFiles.size &&
      !themeFiles.some((file) => !this.themeFiles.has(file)) &&
      ![...this.themeFiles].some((file) => !themeFiles.includes(file))
    ) {
      return
    }

    const validDefaultTheme = this.getValidDefaultTheme(themeFiles, defaultTheme)
    const code = this.getThemeModuleCode(themeFiles, validDefaultTheme, watchMode)

    await this.writeToThemeModule(themeExportPath, code).catch((err) => {
      this.themeFiles.clear()
      throw err
    })
  }

  // 获取有效的默认主题
  private getValidDefaultTheme(themeFiles: string[], defaultTheme: string) {
    let validTheme
    if (themeFiles.some((file) => getFileThemeName(file) === defaultTheme)) {
      validTheme = defaultTheme
    } else if (themeFiles.length) {
      validTheme = getFileThemeName(themeFiles[0])
    } else {
      validTheme = ''
    }
    if (this.logger && (!validTheme || validTheme !== defaultTheme)) {
      this.logger.warn(`No default theme named by '${defaultTheme}' was found`)
      if (validTheme) {
        this.logger.warn(`The theme named by '${validTheme}' will used as the default`)
      }
    }
    return validTheme
  }

  // 写入主题模块文件
  private writeToThemeModule(filePath: string, content: string): Promise<any>
  private writeToThemeModule(filePath: string, content: string, sync: boolean): void
  private writeToThemeModule(filePath: string, content: string, sync = false) {
    if (sync) {
      return fs.writeFileSync(filePath, content)
    }
    return promisify(fs.writeFile)(filePath, content)
  }

  // 重置主题模块
  private resetThemeModule() {
    const { themeExportPath, esModule } = this.options
    const defaultExportPath = resolveDefaultExportPath()
    const content = `
var themes = []
${esModule ? 'export default themes' : 'module.exports = themes'}\n`

    this.writeToThemeModule(themeExportPath, content, true)

    if (!isSamePath(themeExportPath, defaultExportPath)) {
      this.writeToThemeModule(defaultExportPath, content, true)
    }
  }

  // 生成主题模块代码
  private getThemeModuleCode(themeFiles: string[], defaultTheme: string, watchMode: boolean) {
    const { themeRequestToken, options } = this
    const { esModule } = options
    const exportStatement = `${esModule ? 'export default ' : 'module.exports = '}themes\n`

    this.themeFiles.clear()

    const imports = []
    const themes = []
    const hotUpdateResources: { name: string; path: string }[] = []
    const runtime = JSON.stringify(path.join(__dirname, 'lib/asyncRuntime'))

    if (esModule) {
      imports.push(`import registerThemes from ${runtime}`)
    } else {
      imports.push(`var _def = function(m) { return m && m.__esModule ? m.default : m }`)
      imports.push(`var registerThemes = _def(require(${runtime}))`)
    }

    for (const [index, file] of Object.entries(themeFiles)) {
      this.themeFiles.add(file)
      const name = getFileThemeName(file)
      const ident = `theme${index}`
      const isDefault = name === defaultTheme

      const originalResource = `${
        !isDefault ? `!!${themeLoader.filepath}!` : ''
      }${file}?token=${themeRequestToken}`
      const resource = JSON.stringify(originalResource)

      hotUpdateResources.push({ name, path: originalResource })
      if (esModule) {
        imports.push(`import ${isDefault ? '' : `${ident} from `}${resource}`)
      } else {
        imports.push(
          isDefault ? `require(${resource})` : `const theme${index} = _def(require(${resource}))`
        )
      }
      themes.push(
        `${''.padEnd(4)}{ name: ${JSON.stringify(name)}, path: ${
          isDefault ? JSON.stringify(`${name}@default`) : ident
        } }`
      )
    }

    imports.push('')
    imports.push(
      `var themes = registerThemes(\n  [\n${themes.join(',\n')}\n  ],\n  ${JSON.stringify(
        defaultTheme
      )}\n)`
    )
    const hmrCode = this.getHotModuleReplaceCode(watchMode, hotUpdateResources, defaultTheme)
    return `/**
 * This File is generated by tools.
 * Please do not modify the contents of this file anyway.
 * 此文件内容由构建工具自动生成，请勿修改。
 */

/* eslint-disable */
// @ts-nocheck

${imports.join('\n')}\n${hmrCode}\n${exportStatement}`
  }

  // 生成热更新代码
  private getHotModuleReplaceCode(
    hot: boolean,
    resources: { name: string; path: string }[],
    defaultTheme: string
  ) {
    if (!hot) {
      return ''
    }
    return `
if (module.hot) {
  // 主题样式文件内容有更新，则重新加载样式
  module.hot.accept(
    [
${resources.map(({ path }) => `${''.padEnd(6)}${JSON.stringify(path)}`).join(',\n')}
    ],
    function () {
      var themes = [
${resources
  .map(
    ({ name, path }) =>
      `${''.padEnd(8)}{
${''.padEnd(10)}name: ${JSON.stringify(name)},
${''.padEnd(10)}path: require(${JSON.stringify(path)})
${''.padEnd(8)}}`
  )
  .join(',\n')}
      ]

      // 重新注册主题并触发更新
      registerThemes(
        themes.map(function (theme) {
          var path = theme.path
          path = path && path.__esModule ? path['default'] : path

          if (theme.name === ${JSON.stringify(defaultTheme)}) {
            theme.path = ${JSON.stringify(`${defaultTheme}@default`)}
          } else {
            theme.path = path
          }

          return theme
        }),
        ${JSON.stringify(defaultTheme)}
      )
    }
  )

  // 主题模块自身更新则刷新页面
  module.hot.decline()
}
`
  }

  // 根据路径模式，获取主题变量声明文件
  private async getThemeFiles(context: string = process.cwd()) {
    const { themes, themeFilter } = this.options
    const patterns = (Array.isArray(themes) ? themes : [themes]).map((file) =>
      file.replace(/\\/g, '/')
    )
    return (
      await globby(patterns, {
        cwd: context,
        absolute: true,
        onlyFiles: true,
        dot: false,
      })
    )
      .map((file) => path.normalize(file))
      .filter((file) => {
        if (themeFilter instanceof RegExp) {
          return themeFilter.test(file)
        }
        if (typeof themeFilter === 'function') {
          return !!themeFilter(file)
        }
        return isStylesheet(file)
      })
      .sort()
  }

  // 应用loader
  private applyLoader(
    compilerOptions: Configuration,
    matchRule: (rule: RuleSetRule) => boolean,
    getLoader: (rule: RuleSetRule, isUseItem: boolean) => RuleSetUseItem
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
    for (const { rule, siblings, isUseItem } of loaders) {
      const useLoader = getLoader(rule, isUseItem)
      if (isUseItem) {
        siblings.push(useLoader)
      } else {
        const { use, loader, loaders, options, query } = rule
        rule.use = [
          {
            query,
            options,
            loader: use || loader || loaders,
          } as RuleSetUseItem,
          useLoader,
        ]
        delete rule.loader
        delete rule.loaders
        delete rule.options
      }
    }
  }

  // 变量loader用于抽离样式文件中与主题相关的样式属性变量
  private applyVarsLoader(compilerOptions: Configuration) {
    this.applyLoader(
      compilerOptions,
      (rule) => isCssRule(rule),
      (rule) => this.getVarsLoaderRule(rule)
    )
    // 重设css-loader的importLoaders值
    for (const { siblings, index } of findLoader(compilerOptions, 'css-loader')) {
      const loader = siblings[index] as RuleSetLoader
      loader.options = Object.assign({}, loader.options, {
        importLoaders: siblings.length - index - 1,
      })
    }
  }

  // 获取规则定义
  private getVarsLoaderRule(rule: RuleSetRule): RuleSetUseItem {
    let syntax
    if (isCssRule(rule, { syntax: 'scss' })) {
      syntax = 'scss'
    } else if (isCssRule(rule, { syntax: 'less' })) {
      syntax = 'less'
    } else if (isCssRule(rule, { syntax: 'sass' })) {
      syntax = 'sass'
    } else {
      syntax = 'css'
    }
    const { onlyColor, cssModules } = this.options
    return {
      loader: varsLoader.filepath,
      options: {
        cssModules: cssModules === 'auto' ? isCssRule(rule, { onlyModule: true }) : cssModules,
        token: this.themeRequestToken,
        onlyColor,
        syntax,
      } as VarsLoaderOptions,
    }
  }
}

export default ThemeWebpackPlugin
