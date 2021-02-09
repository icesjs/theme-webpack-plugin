import { stringifyRequest } from 'loader-utils'
import { resolveModulePath } from '../lib/resolve'
import { isSamePath } from '../lib/utils'
import { PluginLoader } from '../Plugin'
import MiniCssExtractPlugin from '../lib/MiniCssExtractPlugin'

type LoaderContext = import('webpack').loader.LoaderContext

const cssExtractLoader = MiniCssExtractPlugin.loader

function getNewRequestPath(loaderContext: LoaderContext) {
  const { resourcePath, resourceQuery } = loaderContext
  return JSON.parse(
    stringifyRequest(loaderContext, __filename + '!' + resourcePath + resourceQuery)
  )
}

function hasMiniCssExtractLoader(loaders: LoaderContext['loaders']) {
  return loaders.some(({ path }) => isSamePath(path, cssExtractLoader))
}

function addMiniCssExtractLoader(loaderContext: LoaderContext) {
  const { rootContext, loaders, hot, mode } = loaderContext
  loaders.splice(1, 0, {
    ident: 'mini-css-extract-plugin-loader',
    options: { hmr: mode !== 'production' && hot },
    path: cssExtractLoader,
  })
  // 需要清除 style-loader
  // 不然 mini extract 执行样式模块进行样式抽取时，因为没有浏览器环境，style-loader 的代码会报错
  const styleLoader = resolveModulePath('style-loader', [rootContext])
  loaders.splice(
    loaders.findIndex(({ path }) => isSamePath(styleLoader, path)),
    1
  )
}

// pitch 阶段
const pitch: PluginLoader['pitch'] = function () {
  const { loaders } = this
  // 开始 pitch 主题文件
  if (loaders.length < 2) {
    // 执行顺序：1
    // 由 theme 模块发起的请求进入的该 loader
    // 已禁用其他的loader，所以当前 loader 一定为唯一的 loader
    const callback = this.async() || (() => {})
    // 转发请求
    this.loadModule(getNewRequestPath(this), (err, source, sourceMap) => {
      // 执行顺序：4
      if (err) {
        callback(err)
        return
      }
      callback(null, source, sourceMap)
    })
    return
  }

  // 执行顺序：2
  // 是自己转发的请求
  if (!hasMiniCssExtractLoader(loaders)) {
    // 0号位置，是自身，1号位置，是后一个位置
    // 自身在其后面执行 normal 阶段
    addMiniCssExtractLoader(this)
  }

  // 接下来执行 mini-css-extract-loader 的 pitch
  this.callback(null)
}

// normal 阶段
const themeLoader: PluginLoader = function (source, map) {
  // 执行顺序：3
  // 此处一定是在 mini-css-extract-loader 执行之后
  // this.clearDependencies()
  // this.addDependency(this.resourcePath)
  this.callback(null, source, map)
}

themeLoader.filepath = __filename
themeLoader.pitch = pitch
export default themeLoader
