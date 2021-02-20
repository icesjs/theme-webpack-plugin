import * as fs from 'fs'
import * as path from 'path'
import globby from 'globby'
import { getFileThemeName, getToken, isSamePath, isStylesheet } from './lib/utils'
import { getOptions, PluginOptions, resolveDefaultExportPath, ValidPluginOptions } from './options'
import chunkLoader from './loaders/chunkLoader'
import { promisify } from 'util'

type Logger = import('webpack').Logger

export class ThemeModule {
  protected readonly options: ValidPluginOptions
  protected readonly themeFiles = new Set<string>()
  protected readonly themeRequestToken = getToken()
  protected logger: Logger | null = null

  constructor(opts?: PluginOptions) {
    this.options = getOptions(opts)
    this.resetThemeModule()
  }

  // 创建主题模块
  protected async createThemeModule(context: string, watchMode: boolean) {
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

    try {
      // 异步写入时，可能还未写入完成，就被构建器读取解析，造成错误
      this.writeToThemeModule(themeExportPath, code, true)
    } catch (err) {
      this.themeFiles.clear()
      throw err
    }
  }

  // 重置主题模块
  protected resetThemeModule() {
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

  // 根据路径模式，获取主题变量声明文件
  protected async getThemeFiles(context: string = process.cwd()) {
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
      this.logger.warn(`Not found the default theme named by '${defaultTheme}'`)
      if (validTheme) {
        this.logger.warn(`The theme named by '${validTheme}' will be used as the default`)
      }
    }
    return validTheme
  }

  // 写入主题模块文件
  // private writeToThemeModule(filePath: string, content: string): Promise<any>
  private writeToThemeModule(filePath: string, content: string, sync: boolean): void
  private writeToThemeModule(filePath: string, content: string, sync = false) {
    if (sync) {
      return fs.writeFileSync(filePath, content)
    }
    return promisify(fs.writeFile)(filePath, content)
  }

  // 生成主题模块代码
  private getThemeModuleCode(themeFiles: string[], defaultTheme: string, watchMode: boolean) {
    const { themeRequestToken, options } = this
    const { esModule, extract, themeAttrName } = options
    const exportStatement = `${esModule ? 'export default ' : 'module.exports = '}themes\n`

    this.themeFiles.clear()

    const imports = []
    const themes = []
    const hotUpdateResources: { name: string; path: string }[] = []
    const runtime = JSON.stringify(
      path.join(__dirname, `lib/${extract ? 'runtimeAsync' : 'runtime'}`)
    )

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
        extract && !isDefault ? `!!${chunkLoader.filepath}!` : ''
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
        }, css: ${JSON.stringify('')} }`
      )
    }

    imports.push('')
    imports.push(
      `var themes = registerThemes(\n  [\n${themes.join(',\n')}\n  ],\n  ${JSON.stringify(
        defaultTheme
      )}${!extract ? `,\n  ${JSON.stringify(themeAttrName)}` : ''}\n)`
    )
    const hmrCode = this.getHotModuleReplaceCode(
      watchMode,
      hotUpdateResources,
      defaultTheme,
      themeAttrName
    )
    return `/**
 * This file is generated by tools.
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
    defaultTheme: string,
    themeAttrName: string
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
          theme.css = ${JSON.stringify('')}

          return theme
        }),
        ${JSON.stringify(defaultTheme)},
        ${JSON.stringify(themeAttrName)}
      )
    }
  )

  // 主题模块自身更新则刷新页面
  module.hot.decline()
}
`
  }
}
