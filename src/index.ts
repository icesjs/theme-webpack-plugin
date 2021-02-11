import { Compiler, Plugin as WebpackPlugin } from 'webpack'
import Plugin, { PluginOptions } from './Plugin'

// 使用单例
let themePlugin: Plugin
class ThemeWebpackPlugin implements WebpackPlugin {
  constructor(options?: PluginOptions) {
    if (!themePlugin) {
      themePlugin = new Plugin(options)
    }
  }
  apply(compiler: Compiler) {
    if (themePlugin) {
      return themePlugin.apply(compiler)
    }
    throw new Error('Illegal call')
  }
}

export = ThemeWebpackPlugin
