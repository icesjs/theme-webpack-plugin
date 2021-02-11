import type {
  Compiler,
  Configuration,
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
import { getFileThemeName, getToken, isStylesheet } from './lib/utils'
import varsLoader, { VarsLoaderOptions } from './loader/varsLoader'
import themeLoader from './loader/themeLoader'
import { getOptions, PluginOptions } from './options'

export type WebpackLoader = import('webpack').loader.Loader

export interface PluginLoader extends WebpackLoader {
  filepath: string
  getPluginOptions?: () => PluginOptions
}

//
class ThemeWebpackPlugin implements WebpackPlugin {
  private readonly options: PluginOptions
  private readonly themeFiles = new Set<string>()
  private readonly themeRequestToken = getToken()

  constructor(opts?: PluginOptions) {
    this.options = getOptions(opts)
    themeLoader.getPluginOptions = () => ({ ...this.options })
    varsLoader.getPluginOptions = () => ({ ...this.options })
  }

  // 使用 webpack 插件
  apply(compiler: Compiler) {
    const { options } = this
    const { options: compilerOptions } = compiler
    const { devtool } = compilerOptions
    const { sourceMap } = options
    if (sourceMap === 'auto') {
      options.sourceMap = /eval|inline/.test(`${devtool}`) ? 'inline' : !!devtool
    }
    this.applyVarsLoader(compilerOptions)
    compiler.hooks.run.tapPromise(ThemeWebpackPlugin.name, async (compiler) =>
      this.createThemeModule(compilerOptions.context || compiler.context)
    )
    compiler.hooks.watchRun.tapPromise(ThemeWebpackPlugin.name, async (compiler) =>
      this.createThemeModule(compilerOptions.context || compiler.context)
    )
  }

  // 创建主题模块
  async createThemeModule(context: string) {
    const { defaultTheme, themeExportPath } = this.options
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
    } else if (themeFiles.length) {
      validDefaultTheme = getFileThemeName(themeFiles[0])
    }
    const code = this.getThemeModuleCode(themeFiles, validDefaultTheme || '')
    await promisify(fs.writeFile)(themeExportPath!, code).catch((err) => {
      this.themeFiles.clear()
      throw err
    })
  }

  private getThemeModuleCode(themeFiles: string[], defaultTheme: string) {
    const { themeRequestToken, options } = this
    const { esModule } = options
    const exportStatement = `${esModule ? 'export default ' : 'module.exports = '}themes\n`

    this.themeFiles.clear()
    if (!themeFiles.length) {
      return `const themes = []\n${exportStatement}`
    }

    const imports = []
    const themes = []
    const runtime = JSON.stringify(path.join(__dirname, 'lib/runtime'))

    if (esModule) {
      imports.push(`import useThemes from ${runtime}`)
    } else {
      imports.push(`const _def = function(m) { return m && m.__esModule ? m.default : m }`)
      imports.push(`const useThemes = _def(require(${runtime}))`)
    }

    for (const [index, file] of Object.entries(themeFiles)) {
      this.themeFiles.add(file)
      const name = getFileThemeName(file)
      const resource = JSON.stringify(
        `${
          name !== defaultTheme ? `!!${themeLoader.filepath}!` : ''
        }${file}?esModule=${esModule}&token=${themeRequestToken}`
      )
      if (esModule) {
        imports.push(`import theme${index} from ${resource}`)
      } else {
        imports.push(`const theme${index} = _def(require(${resource}))`)
      }
      themes.push(`{ name: ${JSON.stringify(name)}, path: theme${index} }`)
    }

    imports.push(
      `const themes = useThemes([\n${themes.join(',\n')}\n], ${JSON.stringify(defaultTheme)})`
    )

    return `${imports.join('\n')}\n${exportStatement}`
  }

  // 根据路径模式，获取主题变量声明文件
  async getThemeFiles(context: string = process.cwd()) {
    const { themes, themeFilter } = this.options
    const files = await globby(
      (Array.isArray(themes) ? themes : [themes])
        .filter((file) => typeof file === 'string' && file.trim())
        .map((file) => file!.replace(/\\/g, '/').trim()),
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
      if (themeFilter instanceof RegExp) {
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
    const { sourceMap, onlyColor, cssModules } = this.options
    return {
      loader: varsLoader.filepath,
      options: {
        getThemeFiles: () => [...this.themeFiles.values()],
        cssModules: cssModules === 'auto' ? isCssRule(rule, { onlyModule: true }) : cssModules,
        onlyColor: !!onlyColor,
        token: this.themeRequestToken,
        sourceMap,
        syntax,
      } as VarsLoaderOptions,
    }
  }
}

export default ThemeWebpackPlugin
