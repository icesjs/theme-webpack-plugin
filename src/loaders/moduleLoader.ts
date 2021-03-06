import { stringifyRequest } from 'loader-utils'
import { selfModuleName } from '../lib/selfContext'
import {
  addLoadersAfter,
  escapeRegExpChar,
  fixResolvedCssLoaderOptions,
  getQueryObject,
  isFromModule,
  isSamePath,
  removeLoader,
  themeRequestToken,
} from '../lib/utils'
import { ValidPluginOptions } from '../options'
import { LoaderContext, PluginLoader } from '../ThemePlugin'
import varsLoader from './varsLoader'
import scopeLoader from './scopeLoader'

interface LoaderOptions extends ValidPluginOptions {
  syntax: string
}

// 添加新的loader
function injectLoader(loaderContext: LoaderContext, index: number, options: LoaderOptions) {
  const { onlyColor, syntax, extract, themeAttrName } = options
  const { ident } = loaderContext.loaders[index]
  const injected = []
  const loaderOptions = {
    token: themeRequestToken,
    isStyleModule: true,
    onlyColor,
    syntax,
  }
  if (!extract) {
    injected.push({
      path: scopeLoader.filepath,
      options: { ...loaderOptions, themeAttrName },
      ident: 'theme-scope-loader',
    })
  }
  injected.push({
    path: varsLoader.filepath,
    options: { ...loaderOptions },
    ident: 'theme-vars-loader',
  })
  addLoadersAfter(loaderContext, ident || index, injected)
}

// 清理loader
function clearLoaders(loaderContext: LoaderContext) {
  const { loaders } = loaderContext
  for (const [index, loader] of Object.entries(loaders)) {
    const { path: loaderPath, ident } = loader
    if (
      isSamePath(loaderPath, varsLoader.filepath) ||
      isSamePath(loaderPath, scopeLoader.filepath)
    ) {
      removeLoader(loaderContext, ident || +index)
    }
  }
}

// 获取预处理loader的索引
function getPreprocessorLoaderIndex(loaderContext: LoaderContext, options: LoaderOptions) {
  const { loaders } = loaderContext
  const { syntax } = options
  let matchLoaderRegx
  if (!syntax || syntax === 'auto') {
    matchLoaderRegx = /^(?:less|s[ac]ss|postcss|css)-loader$/
  } else {
    matchLoaderRegx = new RegExp(
      String.raw`^(?:${
        /^s[ac]ss$/.test(syntax) ? 's[ac]ss' : escapeRegExpChar(syntax)
      }|postcss|css)-loader$`
    )
  }
  let index = loaders.length
  while (--index > -1) {
    if (isFromModule(matchLoaderRegx, loaders[index].path)) {
      break
    }
  }
  return index
}

// 检查并设置新的loader
function checkAndSetLoader(loaderContext: LoaderContext, options: LoaderOptions) {
  clearLoaders(loaderContext)
  const preprocessorLoaderIndex = getPreprocessorLoaderIndex(loaderContext, options)

  if (preprocessorLoaderIndex !== -1) {
    const { loaders } = loaderContext
    let { syntax } = options

    if (syntax === 'auto') {
      for (const loader of loaders) {
        const loaderPath = loader.path
        if (isFromModule('sass-loader', loaderPath)) {
          syntax = 'scss'
          break
        }
        if (isFromModule('less-loader', loaderPath)) {
          syntax = 'less'
          break
        }
      }
    }
    options.syntax = syntax === 'auto' ? 'css' : syntax || 'css'
    injectLoader(loaderContext, preprocessorLoaderIndex, options)

    fixResolvedCssLoaderOptions(loaderContext)
  }
}

export const pitch: PluginLoader['pitch'] = function (request: string) {
  const pluginOptions = moduleLoader.getPluginOptions!()
  const { loaders } = this
  if (loaders.length < 2) {
    const resource = stringifyRequest(this, `${__filename}${loaders[0].query || ''}!${request}`)
    const codeSnippets = `module.exports = require(${resource})`

    this.callback(null, `// generated by ${selfModuleName}\n\n${codeSnippets}\n`)
  } else {
    const options = Object.assign(pluginOptions, getQueryObject(this.query) as { syntax: string })
    checkAndSetLoader(this, options as LoaderOptions)
    this.callback(null)
  }
}

const moduleLoader: PluginLoader = function (source, map, meta) {
  this.callback(null, source, map, meta)
}

moduleLoader.pitch = pitch
moduleLoader.filepath = __filename
export default moduleLoader
