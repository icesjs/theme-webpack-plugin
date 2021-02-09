import type {
  Compiler,
  Configuration,
  Plugin as WebpackPlugin,
  RuleSetLoader,
  RuleSetRule,
  RuleSetUseItem,
} from 'webpack'
import type { PluginOptions as MiniCssExtractPluginOptions } from 'mini-css-extract-plugin'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'
import globby from 'globby'
import { find as findLoader, isCssRule } from '@ices/use-loader'
import { getFileThemeName, getToken, isSamePath, isStylesheet } from './lib/utils'
import { resolveModulePath } from './lib/resolve'
import varsLoader, { VarsLoaderOptions } from './loader/varsLoader'
import themeLoader from './loader/themeLoader'
import MiniCssExtractPlugin from './lib/MiniCssExtractPlugin'

export interface PluginOptions {
  /**
   * 是否启用sourceMap。
   * 默认根据webpack配置的devtool进行判定。
   */
  sourceMap?: boolean | 'inline'
  /**
   * 变量声明文件。
   * 可用使用glob语法。
   */
  themes: string | string[]
  /**
   * 一个函数，或正则表达式，用于过滤匹配到的主题文件。
   * 默认过滤 .css, .sass, .scss, .less
   * @param path 匹配到的文件路径
   */
  themeFilter: RegExp | ((path: string) => boolean)
  /**
   * 默认的主题名。建议始终设置默认的主题。
   * 默认的主题不会抽离成单独的css文件。
   * 如果没有指定默认的主题，则名称为 default 的主题，或者第一个匹配到主题将作为默认的主题。
   */
  defaultTheme: string
  /**
   * 是否仅抽取颜色变量。
   * 默认为true。
   */
  onlyColor: boolean
  /**
   * 主题发布目录。相对于构建输出目录。
   * 默认为 themes。
   */
  outputDir: string
  /**
   * 生成的代码是否使用esModule语法。
   * 默认为true。
   */
  esModule: boolean
  /**
   * 是否强制应用 cssModules 插件。
   * 默认根据 文件扩展名(.module.css) 来判定是否应用该插件。
   * 如果不带 .module 后缀的样式文件也启用了cssModules，则可开启此项。
   */
  cssModules: boolean | 'auto'
  /**
   * mini-css-extract-plugin 的配置参数。
   */
  miniCssExtractOptions: MiniCssExtractPluginOptions
}

export type WebpackLoader = import('webpack').loader.Loader

export interface PluginLoader extends WebpackLoader {
  filepath: string
}

//
class ThemeWebpackPlugin implements WebpackPlugin {
  private readonly output = resolveModulePath('@ices/theme/dist/theme.js')
  private readonly options: PluginOptions
  private readonly themeFiles = new Set<string>()
  private readonly themeRequestToken = getToken()
  private readonly miniCssExtractPlugin: MiniCssExtractPlugin

  constructor(opts?: PluginOptions) {
    this.options = Object.assign(
      {
        outputDir: 'themes',
        cssModules: 'auto',
        onlyColor: true,
        esModule: true,
      },
      opts
    )
    const { themes, defaultTheme, miniCssExtractOptions } = this.options
    if (typeof (defaultTheme as any) === 'string' && defaultTheme) {
      this.options.defaultTheme = defaultTheme.toLowerCase()
    } else {
      this.options.defaultTheme = 'default'
    }
    if (
      typeof themes !== 'undefined' &&
      typeof themes !== 'string' &&
      (!Array.isArray(themes) || themes.some((item: any) => typeof item !== 'string'))
    ) {
      throw new Error(
        `[${ThemeWebpackPlugin.name}] The options of 'themes' must be a type of string or string array`
      )
    }
    // 实例化 MiniCssExtractPlugin
    // 这里要在构造函数里就实例化插件，是因为需要在该阶段，对MiniCss插件模块进行代理拦截
    // 如果在apply里再去拦截就迟了，因为那时候如果有先于本插件调用apply的插件，就已经对webpack的compiler绑定上事件了
    this.miniCssExtractPlugin = new MiniCssExtractPlugin(miniCssExtractOptions)
  }

  // 使用 webpack 插件
  apply(compiler: Compiler) {
    const { options: compilerOptions } = compiler
    const { devtool } = compilerOptions
    const { sourceMap } = this.options
    if (typeof sourceMap !== 'boolean' && sourceMap !== 'inline') {
      this.options.sourceMap = /eval|inline/.test(`${devtool}`) ? 'inline' : !!devtool
    }
    //
    this.applyVarsLoader(compilerOptions)
    this.miniCssExtractPlugin.apply(compiler)
    ThemeWebpackPlugin.checkMiniCssExtractLoader(compilerOptions)
    //
    compiler.hooks.run.tapPromise(ThemeWebpackPlugin.name, async (compiler) =>
      this.createThemeModule(compilerOptions.context || compiler.context)
    )
    compiler.hooks.watchRun.tapPromise(ThemeWebpackPlugin.name, async (compiler) =>
      this.createThemeModule(compilerOptions.context || compiler.context)
    )
  }

  // 创建主题模块
  async createThemeModule(context: string) {
    const { defaultTheme, esModule } = this.options
    const themeFiles = await this.getThemeFiles(context)
    if (
      !themeFiles.some((file) => !this.themeFiles.has(file)) &&
      ![...this.themeFiles].some((file) => !themeFiles.includes(file))
    ) {
      return
    }

    let validDefaultTheme
    if (themeFiles.some((file) => getFileThemeName(file) === defaultTheme)) {
      validDefaultTheme = defaultTheme
    } else {
      validDefaultTheme = getFileThemeName(themeFiles[0])
    }

    const exports = this.getThemeModuleExports(themeFiles, validDefaultTheme)
    await promisify(fs.writeFile)(
      this.output,
      `${esModule ? 'export default ' : 'module.exports = '} [\n${exports.join(',\n')}\n]`
    ).catch((err) => {
      this.themeFiles.clear()
      throw err
    })
  }

  private getThemeModuleExports(themeFiles: string[], validDefaultTheme: string) {
    const { themeRequestToken, options } = this
    const { outputDir } = options
    this.themeFiles.clear()
    const exports = []

    for (const file of themeFiles) {
      this.themeFiles.add(file)
      const name = getFileThemeName(file)

      exports.push(
        `{ name: ${JSON.stringify(name)}, activated: ${JSON.stringify(
          name === validDefaultTheme
        )}, activate: () => import(/* webpackChunkName: ${JSON.stringify(
          path
            .join(outputDir, name)
            .replace(/\\/g, '/')
            .replace(/^\.*\/+|\/+$/, '')
        )}, webpackMode: ${JSON.stringify(
          name !== validDefaultTheme ? 'lazy' : 'eager'
        )} */ ${JSON.stringify(`!!${themeLoader.filepath}!${file}?token=${themeRequestToken}`)}) }`
      )
      //
    }
    return exports
  }

  // 根据路径模式，获取主题变量声明文件
  async getThemeFiles(context: string = process.cwd()) {
    const { themes, themeFilter } = this.options
    const files = await globby(
      (Array.isArray(themes) ? themes : [themes])
        .filter((file: any) => typeof file === 'string' && file.trim())
        .map((file) => file.replace(/\\/g, '/').trim()),
      {
        cwd: context,
        absolute: true,
        onlyFiles: true,
        dot: false,
      }
    )
    return files.filter((file) => {
      if (typeof themeFilter === 'function') {
        return !!themeFilter(file)
      }
      if ((themeFilter as any) instanceof RegExp) {
        return themeFilter.test(file)
      }
      return isStylesheet(file)
    })
  }

  // 应用loader
  private applyLoader(
    compilerOptions: Configuration,
    matchRule: (rule: RuleSetRule) => boolean,
    getLoader: (rule: RuleSetRule, isUseItem: boolean) => RuleSetUseItem
  ) {
    const loaders = findLoader(
      compilerOptions,
      ({ siblings, index, isUseItem, rule }) => {
        if (matchRule(rule)) {
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

  // 检查MiniCssExtractLoader是不是当前模块引入的插件的loader
  private static checkMiniCssExtractLoader(compilerOptions: Configuration) {
    const cssExtractLoader = MiniCssExtractPlugin.loader
    for (const { loader, index, siblings } of findLoader(
      compilerOptions,
      'mini-css-extract-plugin'
    )) {
      if (!isSamePath(loader, cssExtractLoader)) {
        const item = siblings[index]
        if (typeof item === 'string') {
          siblings[index] = cssExtractLoader
        } else if (typeof item === 'object') {
          Object.assign(item, { loader: cssExtractLoader })
        }
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
    const { sourceMap, cssModules, onlyColor } = this.options
    return {
      loader: varsLoader.filepath,
      options: {
        getThemeFiles: () => [...this.themeFiles.values()],
        cssModules: cssModules === 'auto' ? isCssRule(rule, { onlyModule: true }) : cssModules,
        onlyColor: Boolean(onlyColor),
        token: this.themeRequestToken,
        sourceMap,
        syntax,
      } as VarsLoaderOptions,
    }
  }
}

export default ThemeWebpackPlugin
