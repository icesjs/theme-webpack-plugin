import * as path from 'path'
import { format } from 'util'
import { interpolateName } from 'loader-utils'
import { ValidPluginOptions } from '../options'
import { LoaderContext, PluginLoader } from '../ThemePlugin'
import { hasOwnProperty, isEsModuleExport, normalizePublicPath } from '../lib/utils'
import exec from '../lib/vm'

type PitchFunction = import('webpack').loader.Loader['pitch']

// 获取当前模块文件的构建输出路径
function getCssOutputPath(
  loaderContext: LoaderContext,
  source: string,
  options: ValidPluginOptions
) {
  const { rootContext, resourcePath } = loaderContext
  const { filename, outputPath } = options
  const file = interpolateName(loaderContext, filename as string, {
    context: rootContext,
    content: source,
  })
  let outputFile
  if (outputPath) {
    if (typeof outputPath === 'function') {
      outputFile = outputPath(file, resourcePath, rootContext)
    } else {
      outputFile = path.join(outputPath, file)
    }
  } else {
    outputFile = file
  }
  return outputFile
}

// 获取资源过滤函数
function formatResourceFilter(
  loaderContext: LoaderContext,
  resourceFilter: ValidPluginOptions['resourceFilter']
) {
  const { resourcePath } = loaderContext
  if (!resourceFilter) {
    resourceFilter = /\.(?:png|bmp|ico|gif|jpe?g|avif|svg|eot|woff|otf|ttf)$/i
  }
  return (file: string) => {
    if (resourceFilter instanceof RegExp) {
      return resourceFilter.test(file)
    }
    if (typeof resourceFilter === 'function') {
      return resourceFilter(file, resourcePath)
    }
    return false
  }
}

// 获取默认的资源部署路径，相对于构建输出目录
function getDefaultPublicPath(
  loaderContext: LoaderContext,
  source: string,
  outputPath: string,
  options: ValidPluginOptions
) {
  const cssOutputPath = getCssOutputPath(loaderContext, source, options)
  return path.relative(path.join(outputPath, path.dirname(cssOutputPath)), outputPath)
}

// 获取publicPath回调函数
function getPublicPathCallback(
  loaderContext: LoaderContext,
  defaultPublicPath: string,
  outputPublicPath: string,
  options: ValidPluginOptions
) {
  const { resourcePath, rootContext } = loaderContext
  const { resourcePublicPath, resourceFilter } = options
  const filter = formatResourceFilter(loaderContext, resourceFilter)
  return async (file: string) => {
    let publicPath
    if (filter(file)) {
      if (typeof resourcePublicPath === 'function') {
        publicPath = await resourcePublicPath(file, resourcePath, rootContext)
      } else if (typeof resourcePublicPath === 'string') {
        publicPath = resourcePublicPath
      } else {
        publicPath = defaultPublicPath
      }
    } else {
      publicPath = outputPublicPath
    }
    return normalizePublicPath(publicPath)
  }
}

// 获取主题引用资源的发布路径，该路径对于css中资源引用(url(xxx))的路径很重要
function getResourcePublicPath(
  loaderContext: LoaderContext,
  source: string,
  pluginOptions: ValidPluginOptions
) {
  const { resourceFilter, resourcePublicPath } = pluginOptions
  const compilerOptions = extractLoader.getCompilerOptions!()
  const { output } = compilerOptions
  const outputPublicPath = output.publicPath
  const defaultPublicPath = getDefaultPublicPath(
    loaderContext,
    source,
    output.path || '',
    pluginOptions
  )
  // 需要对资源进行筛选
  if (resourceFilter || typeof resourcePublicPath === 'function') {
    return getPublicPathCallback(
      loaderContext,
      defaultPublicPath,
      outputPublicPath || '',
      pluginOptions
    )
  }

  // 使用固定的资源部署路径
  if (typeof resourcePublicPath === 'string') {
    return normalizePublicPath(resourcePublicPath)
  }

  // 默认的基于构建目录的相对路径
  return normalizePublicPath(defaultPublicPath)
}

// 获取资源内容
function defaultGetCssContent(exports: any) {
  let css
  exports = isEsModuleExport(exports) ? exports.default : exports
  if (hasOwnProperty(exports, 'toString', 'function')) {
    css = exports.toString()
  } else if (Array.isArray(exports)) {
    css = exports[1] || ''
  } else {
    css = exports
  }
  return typeof css === 'string' ? css : format(css)
}

// 注入代码到模块代码结尾，并在虚拟机中运行
function injectScript() {
  // 这里是虚拟机内的运行环境，模拟的浏览器运行时
  // 可访问当前处理模块的webpack模块上下文，以及window对象等
  return `
    const exports = module.exports
    const defaultExport = exports && exports.__esModule ? exports.default : exports
    if (!Array.isArray(defaultExport) && typeof content !== 'undefined' && Array.isArray(content)) {
      module.exports = content
      module.exports.__originalExports = exports
    }
  `
}

// normal阶段
const extractLoader: PluginLoader = function (source: string | Buffer) {
  if (Buffer.isBuffer(source)) {
    source = source.toString('utf8')
  }
  const pluginOptions = extractLoader.getPluginOptions!()
  const callback = this.async() || (() => {})
  const { getCssContent = defaultGetCssContent } = pluginOptions

  const moduleContext = {
    __webpack_public_path__: getResourcePublicPath(this, source, pluginOptions),
  }

  // 执行虚拟机，运行webpack模块，抽取css模块导出的内容
  exec(this, moduleContext, source, injectScript())
    .then((exports) => getCssContent(exports, this.resourcePath))
    .then((content) => callback(null, content))
    .catch(callback)
}

// pitch方法，创建data对象需要这个阶段的方法
// 没有pitch，webpack不给创建data，而且loaderContext是只读的，不能自己添加属性
// 实际上这里的pitch没啥事可做
export const pitch: PitchFunction = function () {
  this.callback(null)
}

extractLoader.filepath = __filename
extractLoader.pitch = pitch
export default extractLoader
