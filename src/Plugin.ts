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
import { resolveModulePath } from './lib/resolve'
import varsLoader, { VarsLoaderOptions } from './loader/varsLoader'
import themeLoader from './loader/themeLoader'

export interface PluginOptions {
  /**
   * 是否启用sourceMap。<br>
   * 默认根据webpack配置的devtool进行判定。
   */
  sourceMap?: boolean | 'inline'
  /**
   * 变量声明文件。<br>
   * 可用使用glob语法。
   */
  themes?: string | string[]
  /**
   * 一个函数，或正则表达式，用于过滤匹配到的主题文件。<br>
   * 默认过滤 .css, .sass, .scss, .less<br>
   * @param path 匹配到的文件路径
   */
  themeFilter?: RegExp | ((path: string) => boolean)
  /**
   * 主题内容导出路径。一般不需要配置这项。<br>
   * 如果默认的主题管理包 <code>@ices/theme</code> 不符合你的主题管理要求，
   * 你需要使用自己的主题管理器，则可以通过这个配置项指定一个路径地址。<br>
   * 本插件会将导出的内容输出到这个路径指定的文件中。<br>
   * 其默认导出为一个包含主题描述对象的数组，其格式为：
   * <br>
   * <pre>
   * // 默认导出为一个数组，数组元素为一个主题对象
   * [{
   *   name: string, // 主题的名称，来自于主题文件名
   *   activated: boolean,  // 主题是否处于激活状态
   *   activate: () => Promise<string> // 激活主题的方法，返回值Promise resolve参数为当前主题名称，reject参数为异常对象
   * }]
   * </pre>
   * <br>
   * 然后你就可以通过自己的代码来导入这个文件，并通过主题对象的 <code>activate()</code> 方法来激活该主题了。
   * 请确保此路径指定的文件是可写的。<br>
   * 注意，<code>activate()</code> 方法返回的是一个 <code>Promise</code> 对象。<br>
   * 默认为 <code>@ices/theme/dist/theme.js<code>
   */
  themeExportPath?: string
  /**
   * 默认的主题名。建议始终设置默认的主题。<br>
   * 默认的主题不会抽离成单独的css文件。<br>
   * 如果没有指定默认的主题，则名称为 default 的主题，或者第一个匹配到主题将作为默认的主题。
   */
  defaultTheme?: string
  /**
   * 是否仅抽取来自于主题文件中声明的代表颜色的变量。默认为true。<br>
   * 本插件会根据实际可包含颜色定义的样式属性声明（比如 <code>border</code>、<code>background</code>），
   * 检查其值是否引用了变量，并根据引用变量的上下文环境，计算出其真实值，然后检查其真实值是否是一个颜色值。<br>
   * 颜色值包括颜色名称（比如 <code>green</code> 代表绿色，<code>transparent</code> 代表透明色），
   * 以及符合 <code>Web</code> 标准的颜色代码
   * （比如 <code>#fff</code>、<code>rgb</code>、<code>rgba</code>、<code>hsl</code>）等等。
   * <br>
   * 注意，如果变量的引用不是来自于主题文件，则此变量不会被抽取，所以，你的样式文件还是需要导入要使用的主题样式文件的。<br>
   * 一般你只需要导入默认的主题样式文件即可，默认的主题样式文件里可声明所有需要用到的主题变量，当然如果你不导入主题样式文件，
   * 编译特定语法的样式文件（比如 xxx.scss）也会报错，因为找不到对应的变量，所以无论如何你还是要在你的样式文件里导入至少一个主题声明文件的。<br>
   * 被抽取的变量，会将其当前已声明的值赋为var(--xxx)变量引用的默认值，
   * 如果动态插入页面的那个主题里没有你的那个变量，也会使用你在写代码的时候，所引用变量的那个值。所以你不需要担心在浏览器端运行时，动态引用的主题里是否有你要的那个变量。<br>
   */
  onlyColor?: boolean
  /**
   * 主题发布目录。相对于构建输出目录。<br>
   * 默认为 themes。
   */
  outputDir?: string
  /**
   * 生成的代码是否使用esModule语法。<br>
   * 默认为true。
   */
  esModule?: boolean
  /**
   * 是否强制应用 cssModules 插件，并设置 postcss-modules 插件的配置项（此配置仅仅用于语法解析）。<br>
   * 如果值为一个对象，将传递给 postcss-modules 插件。<br>
   * 注意，此处配置仅在抽取变量时，用于语法解析，且不会影响实际的样式文件处理输出。<br>
   * 如果你需要配置实际的 css modules 文件的转换输出规则，你仍然需要去你配置 loader 的地方去配置。<br>
   * 默认值为 auto，即根据文件扩展名(.module.xxx)来判定是否应用 postcss-modules 插件。<br>
   * 如果不带 .module 后缀的样式文件也启用了cssModules，则可开启此项。
   */
  cssModules?: boolean | 'auto' | { [p: string]: any }
}

export type WebpackLoader = import('webpack').loader.Loader

export interface PluginLoader extends WebpackLoader {
  filepath: string
}

//
class ThemeWebpackPlugin implements WebpackPlugin {
  private readonly options: PluginOptions
  private readonly themeFiles = new Set<string>()
  private readonly themeRequestToken = getToken()

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
    const { themes, defaultTheme, outputDir, themeExportPath } = this.options
    if (typeof (defaultTheme as any) === 'string' && defaultTheme) {
      this.options.defaultTheme = defaultTheme.toLowerCase()
    } else {
      this.options.defaultTheme = 'default'
    }
    if (!outputDir || typeof (outputDir as any) !== 'string') {
      this.options.outputDir = 'themes'
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
    if (!themeExportPath || typeof (themeExportPath as any) !== 'string') {
      const defaultLib = resolveModulePath('@ices/theme/dist/theme.js')
      if (!fs.existsSync(defaultLib)) {
        throw new Error(
          'There are no installed theme lib, please install "@ices/theme" first or set the option of "themeExportPath"'
        )
      }
      this.options.themeExportPath = defaultLib
    } else {
      this.options.themeExportPath = path.resolve(themeExportPath)
    }
  }

  // 使用 webpack 插件
  apply(compiler: Compiler) {
    const { options: compilerOptions } = compiler
    const { devtool } = compilerOptions
    const { sourceMap } = this.options
    if (typeof sourceMap !== 'boolean' && sourceMap !== 'inline') {
      this.options.sourceMap = /eval|inline/.test(`${devtool}`) ? 'inline' : !!devtool
    }
    this.applyVarsLoader(compilerOptions)
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
        .filter((file: any) => typeof file === 'string' && file.trim())
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
      if ((themeFilter as any) instanceof RegExp) {
        return themeFilter!.test(file)
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
    const { sourceMap, onlyColor, cssModules = 'auto' } = this.options
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
