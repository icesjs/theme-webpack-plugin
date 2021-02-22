import { stringifyRequest } from 'loader-utils'
import { selfModuleName } from '../lib/selfContext'
import { isFromModule } from '../lib/resolve'
import { PluginLoader } from '../ThemePlugin'
import { ValidPluginOptions } from '../options'
import extractLoader from './extractLoader'

type LoaderContext = import('webpack').loader.LoaderContext

// 清理不需要的loader
function clearLoaders(loaderContext: LoaderContext) {
  const { loaders } = loaderContext
  for (const loader of [...loaders]) {
    if (typeof loader !== 'object') {
      continue
    }
    const { path: loaderPath } = loader
    if (
      // 这些extract相关的loader提供的API要么不适合当前需求，要么过期不维护，要么有bug
      isFromModule('mini-css-extract-plugin', loaderPath) ||
      isFromModule('extract-css-chunks-webpack-plugin', loaderPath) ||
      isFromModule('extract-text-webpack-plugin', loaderPath) ||
      isFromModule('extract-loader', loaderPath) ||
      // resolve-url-loader 这个loader根据源码映射来处理路径的转换，对于变量导入的一些路径，处理不正确
      // 这里移除这个插件，根据变量依赖分析自行处理路径转换
      isFromModule('resolve-url-loader', loaderPath) ||
      // 我们不需要style-loader将样式转换为js模块
      isFromModule('style-loader', loaderPath) ||
      // 先清除已使用的file-loader，后面我们再添加
      isFromModule('file-loader', loaderPath)
    ) {
      loaders.splice(loaders.indexOf(loader), 1)
    }
  }
}

// 检查并设置相应loader
function checkAndSetLoader(loaderContext: LoaderContext, pluginOptions: ValidPluginOptions) {
  const { loaders } = loaderContext

  clearLoaders(loaderContext)

  for (const [index, loader] of Object.entries(loaders)) {
    if (isFromModule('css-loader', loader.path)) {
      const options = loader.options || loader.query
      if (typeof options === 'object') {
        // 修正下css-loader的参数
        options.importLoaders = loaders.length - Number(index) - 1
        break
      }
    }
  }

  const { esModule, publicPath, outputPath, filename } = pluginOptions
  // 添加loader
  loaders.splice(
    1, // 0号索引为当前chunk-loader，我们添加新loader到当前loader的后面
    0,
    // 这里的添加顺序不能错
    {
      path: require.resolve('file-loader'),
      options: {
        esModule,
        outputPath,
        publicPath,
        name: filename,
      },
      ident: 'file-loader',
    },
    {
      // 使用自己实现的css资源抽取loader
      path: extractLoader.filepath,
      options: {},
      ident: 'extract-theme-css-loader',
    }
  )
}

export const pitch: PluginLoader['pitch'] = function () {
  const pluginOptions = chunkLoader.getPluginOptions!()
  const { loaders } = this
  if (loaders.length < 2) {
    const { esModule } = pluginOptions
    // 首次由主题模块请求进入
    // 模块默认导出的是通过file-loader发布资源后的资源路径
    // 变量的抽取将由vars-loader处理
    const resource = stringifyRequest(this, __filename + '!' + this.resource)
    const imports = esModule
      ? `import cssPath from ${resource}`
      : `const cssPath = require(${resource})`
    const exports = esModule ? `export default cssPath` : `module.exports = cssPath`
    this.callback(null, `// generated by ${selfModuleName}\n\n${imports}\n\n${exports}\n`)
  } else {
    // 转发资源请求时进入
    // 检查并添加新的loader
    checkAndSetLoader(this, pluginOptions)
    // 执行loader链
    this.callback(null)
  }
}

const chunkLoader: PluginLoader = function (source, map, meta) {
  // 因为对于当前请求，我们是两次进入chunk-loader，所以在normal阶段我们需要返回模块内容
  this.callback(null, source, map, meta)
}

chunkLoader.filepath = __filename
chunkLoader.pitch = pitch
export default chunkLoader
