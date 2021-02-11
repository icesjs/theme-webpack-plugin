import { stringifyRequest } from 'loader-utils'
import { selfModuleName } from '../lib/selfContext'
import { isFromModule } from '../lib/resolve'
import { PluginLoader } from '../Plugin'
import { getQueryObject } from '../lib/utils'

type LoaderContext = import('webpack').loader.LoaderContext

function checkAndSetLoader(loaderContext: LoaderContext) {
  const { loaders } = loaderContext

  loaders.forEach((loader, index) => {
    if (typeof loader !== 'object') {
      return
    }
    const { path: loaderPath } = loader
    if (
      // 这里使用extract-loader来抽取内容，因为我们需要将抽取的内容转换为资源路径导出
      isFromModule('mini-css-extract-plugin', loaderPath) ||
      isFromModule('extract-css-chunks-webpack-plugin', loaderPath) ||
      // 我们不需要style-loader将样式转换为js模块
      isFromModule('style-loader', loaderPath) ||
      // 先清除已使用的file-loader，后面我们再添加
      isFromModule('file-loader', loaderPath) ||
      // 先清除已使用的extract-loader，后面我们再添加
      isFromModule('extract-loader', loaderPath)
    ) {
      loaders.splice(index, 1)
    }
  })

  const { esModule, publicPath, outputPath, filename } = themeLoader.getPluginOptions!()

  // 添加loader
  loaders.splice(
    1, // 0号索引为当前theme-loader，我们添加新loader到当前loader的后面
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
    },
    {
      path: require.resolve('extract-loader'),
      options: { esModule },
    }
  )
}

function getThemeResource(loaderContext: LoaderContext) {
  const { resourcePath, resourceQuery } = loaderContext
  return stringifyRequest(loaderContext, __filename + '!' + resourcePath + resourceQuery)
}

export const pitch: PluginLoader['pitch'] = function () {
  const { loaders, resourceQuery } = this
  const { esModule } = getQueryObject(resourceQuery)
  if (loaders.length < 2) {
    // 首次由主题模块请求进入
    const resource = getThemeResource(this)
    const imports = esModule
      ? `import cssPath from ${resource}`
      : `const cssPath = require(${resource})`
    const exports = esModule ? `export default cssPath` : `module.exports = cssPath`

    // 模块默认导出的是通过file-loader发布资源后的资源路径
    // 变量的抽取将由vars-loader处理
    this.callback(null, `// generated by ${selfModuleName}\n\n${imports}\n\n${exports}\n`)
  } else {
    // 转发资源请求时进入
    // 检查并添加新的loader
    checkAndSetLoader(this)
    // 执行loader链
    this.callback(null)
  }
}

const themeLoader: PluginLoader = function (source, map) {
  // 因为对于当前请求，我们是两次进入theme-loader，所以在normal阶段我们需要返回模块内容
  this.callback(null, source, map)
}

themeLoader.filepath = __filename
themeLoader.pitch = pitch
export default themeLoader
