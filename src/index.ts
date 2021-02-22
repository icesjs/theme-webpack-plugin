import { Compiler, Plugin as WebpackPlugin } from 'webpack'
import { PluginOptions } from './options'
import ThemePlugin from './ThemePlugin'

// 使用单例
let themePlugin: ThemePlugin
class ThemeWebpackPlugin implements WebpackPlugin {
  static ThemePlugin = ThemePlugin
  constructor(options?: PluginOptions) {
    if (!themePlugin) {
      themePlugin = new ThemePlugin(options)
    }
  }
  apply(compiler: Compiler) {
    if (themePlugin) {
      return themePlugin.apply(compiler)
    }
    throw new Error('Illegal invocation')
  }
}

export = ThemeWebpackPlugin
