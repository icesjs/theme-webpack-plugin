import { getOptions } from 'loader-utils'
import postcss from 'postcss'
import { PluginLoader } from '../Plugin'
import { getASTFromMeta, getFileThemeName, getQueryObject, isStylesheet } from '../lib/utils'
import { VarsLoaderOptions } from './varsLoader'
import { addThemeScopePlugin } from '../lib/postcss/plugins'

const scopeLoader: PluginLoader = function (source, map, meta) {
  const { resourcePath, resourceQuery } = this
  const { token: queryToken } = getQueryObject(resourceQuery)
  const { syntax, token, onlyColor } = (getOptions(this) as unknown) as VarsLoaderOptions

  if (queryToken !== token || !isStylesheet(resourcePath)) {
    this.callback(null, source, map, meta)
    return
  }

  const syntaxPlugin = require(`postcss-${syntax === 'css' ? 'safe-parser' : syntax}`)
  const scope = getFileThemeName(resourcePath)
  const { root } = getASTFromMeta(meta)

  const callback = this.async() || (() => {})

  postcss([addThemeScopePlugin({ syntax, syntaxPlugin, onlyColor, scope })])
    .process(root || source, {
      syntax: syntaxPlugin,
      from: resourcePath,
      to: resourcePath,
      map: false,
    })
    .then(({ css }) => callback(null, css, undefined))
    .catch(callback)
}

scopeLoader.filepath = __filename
export default scopeLoader
