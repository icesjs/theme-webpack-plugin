import postcss from 'postcss'
import { getOptions } from 'loader-utils'
import { addThemeScopePlugin } from '../lib/postcss/plugins'
import { PluginLoader } from '../Plugin'
import { VarsLoaderOptions } from './varsLoader'
import {
  getASTFromMeta,
  getFileThemeName,
  getQueryObject,
  getValidSyntax,
  isStylesheet,
} from '../lib/utils'

const scopeLoader: PluginLoader = function (source, map, meta) {
  const { resourcePath, resourceQuery } = this
  const { token: queryToken } = getQueryObject(resourceQuery)
  const { syntax: rawSyntax, token, onlyColor, themeAttrName = 'data-theme' } = (getOptions(
    this
  ) as unknown) as VarsLoaderOptions
  const syntax = getValidSyntax(rawSyntax)

  if (queryToken !== token || !isStylesheet(resourcePath)) {
    this.callback(null, source, map, meta)
    return
  }

  const syntaxPlugin = require(`postcss-${syntax === 'css' ? 'safe-parser' : syntax}`)
  const scope = getFileThemeName(resourcePath)
  const { root } = getASTFromMeta(meta)

  const callback = this.async() || (() => {})

  postcss([addThemeScopePlugin({ syntax, syntaxPlugin, onlyColor, scope, themeAttrName })])
    .process(root || source, {
      syntax: syntaxPlugin,
      from: resourcePath,
      to: resourcePath,
      map: false,
    })
    .then(({ css }) => callback(null, css))
    .catch(callback)
}

scopeLoader.filepath = __filename
export default scopeLoader
