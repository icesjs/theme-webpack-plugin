import * as fs from 'fs'
import * as path from 'path'
import globby from 'globby'
import { getHashDigest } from 'loader-utils'
import { getFileThemeName, isSamePath, isStylesheet, themeRequestToken } from './lib/utils'
import { resolveDefaultExportPath, ValidPluginOptions } from './options'
import chunkLoader from './loaders/chunkLoader'

type Logger = import('webpack').Logger

export class ThemeModule {
  readonly themeFiles = new Set<string>()
  private fileContentHash = ''

  constructor(readonly options: ValidPluginOptions, readonly logger: Logger | null) {
    this.reset()
  }

  // 创建主题模块
  async create(context: string, hot: boolean) {
    const { defaultTheme, themeExportPath } = this.options
    const themeFiles = await this.matchThemeFiles(context)
    if (
      this.themeFiles.size &&
      !themeFiles.some((file) => !this.themeFiles.has(file)) &&
      ![...this.themeFiles].some((file) => !themeFiles.includes(file))
    ) {
      return
    }

    const validDefaultTheme = this.getValidDefaultTheme(themeFiles, defaultTheme)
    const code = this.generateCode(themeFiles, validDefaultTheme, hot)

    this.writeFile(themeExportPath, code)
  }

  // 重置主题模块
  private reset() {
    const { themeExportPath, esModule } = this.options
    const defaultExportPath = resolveDefaultExportPath()
    const content = `
var themes = []
${esModule ? 'export default themes' : 'module.exports = themes'}\n`

    this.fileContentHash = ''
    this.writeFile(themeExportPath, content)

    if (!isSamePath(themeExportPath, defaultExportPath)) {
      this.fileContentHash = ''
      this.writeFile(defaultExportPath, content)
    }
  }

  // 写入主题模块
  private writeFile(filepath: string, content: string) {
    const hash = getHashDigest(Buffer.from(content), 'md4', 'hex', 32)
    if (this.fileContentHash !== hash) {
      try {
        fs.writeFileSync(filepath, content)
        this.fileContentHash = hash
      } catch (err) {
        this.fileContentHash = ''
        this.themeFiles.clear()
        throw err
      }
    }
  }

  // 根据路径模式，获取主题变量声明文件
  private async matchThemeFiles(context: string = process.cwd()) {
    const { themes, themeFilter } = this.options
    const patterns = (Array.isArray(themes) ? themes : [themes]).map((file) =>
      file.replace(/\\/g, '/')
    )
    const files = (
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

    const names = new Map<string, string>()

    for (const file of files) {
      const name = getFileThemeName(file)
      if (names.has(name)) {
        const cwd = process.cwd()
        throw new Error(
          `Cannot use the theme files with the same base name: "${path.relative(
            cwd,
            names.get(name)!
          )}"、"${path.relative(cwd, file)}"`
        )
      }
      names.set(name, file)
    }

    if (!files.length && this.logger) {
      this.logger.info(`Not found any theme by pattern: ${JSON.stringify(patterns)}`)
    }

    return files
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
    if (this.logger && themeFiles.length && (!validTheme || validTheme !== defaultTheme)) {
      this.logger.warn(`Not found the default theme named by '${defaultTheme}'`)
      if (validTheme) {
        this.logger.warn(`The theme named by '${validTheme}' will be used as the default`)
      }
    }
    return validTheme
  }

  // 生成主题模块代码
  private generateCode(themeFiles: string[], defaultTheme: string, hot: boolean) {
    const { esModule, extract, themeAttrName } = this.options
    const exportStatement = `${esModule ? 'export default ' : 'module.exports = '}themes\n`

    this.themeFiles.clear()

    const imports = []
    const themes = []
    const hotUpdateResources: { name: string; path: string; style: string }[] = []
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

      const originalPathResource = `${
        extract && !isDefault ? `!!${chunkLoader.filepath}!` : ''
      }${file}?token=${themeRequestToken}`

      // 有些特别的规则，因为没法添加命名空间，需要单独分离出来，比如 @font-face
      const originalStyleResource = !extract
        ? `!!${chunkLoader.filepath}!${file}?style=true&token=${themeRequestToken}`
        : ''

      const pathResource = JSON.stringify(originalPathResource)
      const styleResource = JSON.stringify(originalStyleResource)

      hotUpdateResources.push({ name, path: originalPathResource, style: originalStyleResource })

      if (esModule) {
        imports.push(`import ${!extract || isDefault ? '' : `${ident} from `}${pathResource}`)
        if (!extract) {
          imports.push(`import ${ident} from ${styleResource}`)
        }
      } else {
        imports.push(
          !extract || isDefault
            ? `require(${pathResource})`
            : `const ${ident} = _def(require(${pathResource}))`
        )
        if (!extract) {
          imports.push(`const ${ident} = _def(require(${styleResource}))`)
        }
      }

      const themePath = extract
        ? isDefault
          ? JSON.stringify(`${name}@default`)
          : ident
        : JSON.stringify('')
      const stylePath = extract ? JSON.stringify('') : ident
      themes.push(
        `${''.padEnd(4)}{ name: ${JSON.stringify(name)}, path: ${themePath}, style: ${stylePath} }`
      )
    }

    imports.push('')
    imports.push(
      `var themes = registerThemes(\n  [\n${themes.join(',\n')}\n  ],\n  ${JSON.stringify(
        defaultTheme
      )}${!extract ? `,\n  ${JSON.stringify(themeAttrName)}` : ''}\n)`
    )

    const hmrCode = hot ? this.generateHMRCode(hotUpdateResources, defaultTheme, themeAttrName) : ''

    return `/**
 * This file is generated by tools.
 * Please do not modify the contents of this file anyway.
 * 此文件内容由构建工具自动生成，请勿修改。
 */

/* eslint-disable */
// @ts-nocheck

${imports.join('\n')}\n${hmrCode}\n${exportStatement}`
    //
  }

  // 生成热更新代码
  private generateHMRCode(
    resources: { name: string; path: string; style: string }[],
    defaultTheme: string,
    themeAttrName: string
  ) {
    return `
if (module.hot) {
  // 主题样式文件内容有更新，则重新加载样式
  module.hot.accept(
    [
${resources
  .map(
    ({ path, style }) =>
      `${''.padEnd(6) + JSON.stringify(path)}` +
      (style ? `,\n${''.padEnd(6) + JSON.stringify(style)}` : '')
  )
  .join(',\n')}
    ],
    function () {
      var themes = [
${resources
  .map(
    ({ name, path, style }) =>
      `${''.padEnd(8)}{
${''.padEnd(10)}name: ${JSON.stringify(name)},
${''.padEnd(10)}path: require(${JSON.stringify(path)})${
        style ? `,\n${''.padEnd(10)}style: require(${JSON.stringify(style)})` : ''
      }
${''.padEnd(8)}}`
  )
  .join(',\n')}
      ]

      // 重新注册主题并触发更新
      registerThemes(
        themes.map(function (theme) {
          var path = theme.path
          var style = theme.style
          path = path && path.__esModule ? path['default'] : path
          style = style && style.__esModule ? style['default'] : style

          if (theme.name === ${JSON.stringify(defaultTheme)}) {
            theme.path = ${JSON.stringify(`${defaultTheme}@default`)}
          } else {
            theme.path = path
          }
          theme.style = style

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
