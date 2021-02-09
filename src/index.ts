import { Compiler, Plugin as WebpackPlugin } from 'webpack'
import MiniCssExtractPlugin from './lib/MiniCssExtractPlugin'
import Plugin, { PluginOptions } from './Plugin'

let themePlugin: Plugin
class ThemeWebpackPlugin implements WebpackPlugin {
  static readonly MiniCssExtractPlugin = MiniCssExtractPlugin
  private readonly themePlugin: Plugin
  constructor(options?: PluginOptions) {
    if (!themePlugin) {
      themePlugin = new Plugin(options)
    }
    this.themePlugin = themePlugin
  }
  apply(compiler: Compiler) {
    return this.themePlugin.apply(compiler)
  }
}

export = ThemeWebpackPlugin
