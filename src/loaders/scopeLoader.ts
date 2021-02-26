import postcss from 'postcss'
import { getOptions } from 'loader-utils'
import { addThemeScopePlugin } from '../lib/postcss/plugins'
import { PluginLoader } from '../ThemePlugin'
import { VarsLoaderOptions } from './varsLoader'
import {
  getASTFromMeta,
  getFileThemeName,
  getQueryObject,
  getResultSourceMap,
  getSourceMapOptions,
  getSupportedSyntax,
  getSyntaxPlugin,
  isStylesheet,
} from '../lib/utils'

const scopeLoader: PluginLoader = function (source, map, meta) {
  const { resourcePath, resourceQuery } = this
  const { token: queryToken } = getQueryObject(resourceQuery)
  const { token, onlyColor, syntax: rawSyntax, themeAttrName = 'data-theme' } = (getOptions(
    this
  ) as unknown) as VarsLoaderOptions
  const syntax = getSupportedSyntax(rawSyntax, resourcePath)

  if (queryToken !== token || !isStylesheet(resourcePath)) {
    this.callback(null, source, map, meta)
    return
  }

  const syntaxPlugin = getSyntaxPlugin(syntax, resourcePath)
  const scope = getFileThemeName(resourcePath)
  const { root } = getASTFromMeta(meta)

  const callback = this.async() || (() => {})

  postcss([addThemeScopePlugin({ syntax, syntaxPlugin, onlyColor, scope, themeAttrName })])
    .process(root || source, {
      syntax: syntaxPlugin,
      from: resourcePath,
      to: resourcePath,
      map: getSourceMapOptions(this, map),
    })
    .then(({ css, map: resultMap }) =>
      callback(null, css, getResultSourceMap(this, resultMap), meta)
    )
    .catch(callback)
}

scopeLoader.filepath = __filename
export default scopeLoader
