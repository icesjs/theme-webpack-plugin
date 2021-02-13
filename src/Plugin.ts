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
  }

  // 使用 webpack 插件
  apply(compiler: Compiler) {
    const { options: compilerOptions } = compiler
    const { mode } = compilerOptions
    const isEnvProduction = mode !== 'development' || process.env.NODE_ENV !== 'development'
    const pluginName = ThemeWebpackPlugin.name

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
  async createThemeModule(context: string, watchMode: boolean) {
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
    const code = this.getThemeModuleCode(themeFiles, validDefaultTheme || '', watchMode)

    await promisify(fs.writeFile)(themeExportPath!, code).catch((err) => {
      this.themeFiles.clear()
      throw err
    })
  }

  private getThemeModuleCode(themeFiles: string[], defaultTheme: string, watchMode: boolean) {
    const { themeRequestToken, options } = this
    const { esModule } = options
    const exportStatement = `${esModule ? 'export default ' : 'module.exports = '}themes\n`

    this.themeFiles.clear()

    const imports = []
    const themes = []
    const hotUpdateResources: { name: string; path: string }[] = []
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
      const ident = `theme${index}`
      const isDefault = name === defaultTheme

      const originalResource = `${
        !isDefault ? `!!${themeLoader.filepath}!` : ''
      }${file}?esModule=${esModule}&token=${themeRequestToken}`
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
        `{ name: ${JSON.stringify(name)}, path: ${isDefault ? '"theme@default"' : ident} }`
      )
    }

    imports.push(
      `const themes = useThemes([\n${themes.join(',\n')}\n], ${JSON.stringify(defaultTheme)})`
    )
    const hmrCode = this.getHotModuleReplaceCode(watchMode, hotUpdateResources, defaultTheme)

    return `${imports.join('\n')}\n${hmrCode}\n${exportStatement}`
  }

  // 获取支持热更新的代码
  getHotModuleReplaceCode(
    hot: boolean,
    resources: { name: string; path: string }[],
    defaultTheme: string
  ) {
    if (!hot) {
      return ''
    }
    return `
if (module.hot) {
  module.hot.accept(
    //
    ${JSON.stringify(resources.map(({ path }) => path))},
    //
    function() {
      var themes = [\n${resources
        .map(
          ({ name, path }) => `{name:${JSON.stringify(name)},path:require(${JSON.stringify(path)})}`
        )
        .join(',\n')}\n]
      //
      useThemes(
        themes.map(function(theme) {
          var path = theme.path
          path = path && path.__esModule ? path['default'] : path
          if (theme.name === ${JSON.stringify(defaultTheme)}) {
            theme.path = "theme@default"
          } else {
            theme.path = path
          }
          return theme
        }),
        ${JSON.stringify(defaultTheme)}
      )
    }
    //
  )
  //
  module.hot.decline()
}`
  }

  // 根据路径模式，获取主题变量声明文件
  async getThemeFiles(context: string = process.cwd()) {
    const { themes, themeFilter } = this.options
    const patterns = (Array.isArray(themes) ? themes : [themes!]).map((file) =>
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
        getThemeFiles: () => [...this.themeFiles.values()],
        cssModules: cssModules === 'auto' ? isCssRule(rule, { onlyModule: true }) : cssModules,
        onlyColor: !!onlyColor,
        token: this.themeRequestToken,
        syntax,
      } as VarsLoaderOptions,
    }
  }
}

export default ThemeWebpackPlugin
