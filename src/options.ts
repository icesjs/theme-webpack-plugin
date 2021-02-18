import * as fs from 'fs'
import * as path from 'path'
import { validate } from 'schema-utils'
import { Schema } from 'schema-utils/declarations/validate'
import { selfModuleName } from './lib/selfContext'
import { resolveModulePath } from './lib/resolve'

const defaultExportPath = '@ices/theme/dist/theme.js'

export interface PluginOptions {
  /**
   * 变量声明文件。<br>
   * 可使用glob语法。
   */
  themes?: string | string[]
  /**
   * 一个函数，或正则表达式，用于过滤匹配到的主题文件。<br>
   * 默认过滤 .css, .sass, .scss, .less<br>
   * @param path 匹配到的文件路径
   */
  themeFilter?: ((path: string) => boolean) | RegExp
  /**
   * 主题内容导出路径。一般不需要配置这项。<br>
   * 如果默认的主题管理包 <code>@ices/theme</code> 不符合你的主题管理要求，
   * 你需要使用自己的主题管理器，则可以通过这个配置项指定一个路径地址。<br>
   * 本插件会将导出的内容输出到这个路径指定的文件中。<br>
   * 其默认导出为一个包含主题描述对象的数组，其格式为：
   * <br>
   * <pre>
   * // 默认导出为一个数组，数组元素为一个主题对象
   * [{
   *   name: string, // 主题的名称，来自于主题文件名
   *   activated: boolean,  // 主题是否处于激活状态
   *   activate: () => Promise<string> // 激活主题的方法，返回值Promise resolve参数为当前主题名称，reject参数为异常对象
   * }]
   * </pre>
   * <br>
   * 然后你就可以通过自己的代码来导入这个文件，并通过主题对象的 <code>activate()</code> 方法来激活该主题了。
   * 请确保此路径指定的文件是可写的。<br>
   * 注意，<code>activate()</code> 方法返回的是一个 <code>Promise</code> 对象。<br>
   * 默认为 <code>@ices/theme/dist/theme.js<code>
   */
  themeExportPath?: string
  /**
   * 默认的主题名。建议始终设置默认的主题。<br>
   * 默认的主题不会抽离成单独的css文件。<br>
   * 如果没有指定默认的主题，则名称为 default 的主题，或者第一个匹配到主题将作为默认的主题。
   */
  defaultTheme?: string
  /**
   * 是否仅抽取来自于主题文件中声明的代表颜色的变量。默认为true。<br>
   * 本插件会根据实际可包含颜色定义的样式属性声明（比如 <code>border</code>、<code>background</code>），
   * 检查其值是否引用了变量，并根据引用变量的上下文环境，计算出其真实值，然后检查其真实值是否是一个颜色值。<br>
   * 颜色值包括颜色名称（比如 <code>green</code> 代表绿色，<code>transparent</code> 代表透明色），
   * 以及符合 <code>Web</code> 标准的颜色代码
   * （比如 <code>#fff</code>、<code>rgb</code>、<code>rgba</code>、<code>hsl</code>）等等。
   * 另外，图片属性也会被当成“颜色值”来处理。也即可以通过主题来更换背景图片。<br>
   * 如果变量的引用不是来自于主题文件，则此变量不会被抽取，所以，你的样式文件还是需要导入要使用的主题样式文件的。<br>
   * 可被当成主题变量抽取的变量声明，含特定语法的变量声明（比如：$scss-var:xxx、@less-var:xxx）以及定义在<code>:root</code>规则上的css自定义属性
   * （<code>:root{--my-prop:xxx}</code>）<br>
   * 注意，如果你在当前文件中声明了一个和导入变量同名的变量，则本插件不会将这个变量提取，也就是说仅有来自于主题文件(含主题文件自身导入的其他文件)中的变量才会被提取。
   * 有一个特殊情况是，如果本地变量值里又使用了其他的变量，而这些其他的变量都来自于主题文件，则该本地变量同样会被提取。
   * 比如：$my-border：1px solid $color-from-dark-theme，在这个本地变量$my-border里面又引用了一个来自主题里面的变量$color-from-dark-theme，因为所有变量的引用
   * 都可以计算出其来源，并确定都是来源于主题文件，所以引用了$my-border变量的声明值，也会被当成动态主题提取。<br>
   * 一般你只需要导入默认的主题样式文件即可，默认的主题样式文件里可声明所有需要用到的主题变量，当然如果你不导入主题样式文件，
   * 编译特定语法的样式文件（比如 xxx.scss）也会报错，因为找不到对应的变量，所以无论如何你还是要在你的样式文件里导入至少一个主题声明文件的。<br>
   * 被抽取的变量，会将其当前已声明的值赋为var(--xxx)变量引用的默认值，
   * 如果动态插入页面的那个主题里没有你的那个变量，也会使用你在写代码的时候，所引用变量的那个值。所以你不需要担心在浏览器端运行时，动态引用的主题里是否有你要的那个变量。<br>
   */
  onlyColor?: boolean
  /**
   * 主题文件的名称模板。<br>
   * 默认为 [name].[contenthash:8].css
   */
  filename?: string | ((resourcePath: string, resourceQuery: string) => string)
  /**
   * 主题文件发布目录。相对于构建输出目录。<br>
   * 默认为 themes。
   */
  outputPath?: string | ((url: string, resourcePath: string, projectContext: string) => string)
  /**
   * 主题文件的发布部署路径。默认为 __webpack_public_path__ + outputPath<br>
   * 这个属性的值影响js代码里面保存的主题样式文件的路径值。js代码里动态插入<code>link</code>标签到页面上时，标签的<code>href</code>引用地址就与这个属性有关。
   */
  publicPath?: string | ((url: string, resourcePath: string, projectContext: string) => string)
  /**
   * 资源文件的相对部署路径。资源文件指在主题文件中引用的url资源，比如图片，字体等。<br>
   * 默认为从主题文件本身的输出目录回退到构建输出目录的相对路径。因为资源文件一般是相对于主题文件本身路径引用的，所以是相对路径。比如，
   * 主题文件相对构建目录输出路径为 <code>static/themes/dark.css</code>，则资源部署路径被设置为 <code>../../</code><br>
   * 如果默认的设置不符合需求，可以通过此项配置设置一个固定的值，或者使用一个函数根据参数返回资源的相对部署路径。<br>
   * 注意，这个配置项影响的是样式文件自身内部对图片、字体等外部资源的引用关系。各种乱七八糟的路径很容易搞混淆搞错，要特别注意。<br>
   * 还有一点是，默认的主题文件是直接打包到应用的样式文件里去的，对外部资源的引用处理一般由css-loader、url-loader以及file-loader处理，而没有经过主题插件的处理。
   * 如果默认主题文件里也有图片等外部资源引用，而且需要自定义资源发布部署路径时，需要到应用自身的样式模块配置(一般是loader配置)里去自定义。<br>
   */
  resourcePublicPath?:
    | string
    | ((
        externalFile: string,
        resourcePath: string,
        projectContext: string
      ) => string | Promise<string>)

  /**
   * 需要计算相对部署路径的资源文件的筛选规则。默认根据资源扩展名称筛选图片、字体等文件。
   */
  resourceFilter?: ((externalFile: string, resourcePath: string) => boolean) | RegExp
  /**
   * 生成的代码是否使用esModule语法。<br>
   * 默认为true。
   */
  esModule?: boolean
  /**
   * 是否强制应用 cssModules 插件，并设置 postcss-modules 插件的配置项（此配置仅仅用于语法解析）。<br>
   * 如果值为一个对象，将传递给 postcss-modules 插件。<br>
   * 注意，此处配置仅在抽取变量时，用于语法解析，且不会影响实际的样式文件处理输出。<br>
   * 如果你需要配置实际的 css modules 文件的转换输出规则，你仍然需要去你配置 loader 的地方去配置。<br>
   * 默认值为 auto，即根据文件扩展名(.module.xxx)来判定是否应用 postcss-modules 插件。<br>
   * 如果不带 .module 后缀的样式文件也启用了cssModules，则可开启此项。
   */
  cssModules?: boolean | 'auto' | { [p: string]: any }
}

//
const schema: Schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    themes: {
      description: 'Directories or Files should be used as theme file. Can use glob pattern.',
      default: [],
      oneOf: [
        {
          type: 'string',
          minLength: 1,
        },
        {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
          },
        },
      ],
    },
    themeFilter: {
      description: 'An RegExp or Function filter for the theme file.',
      oneOf: [{ instanceof: 'RegExp' }, { instanceof: 'Function' }],
    },
    themeExportPath: {
      description: `A file for output the content of theme module (default to "${defaultExportPath}").`,
      default: defaultExportPath,
      type: 'string',
      minLength: 1,
    },
    defaultTheme: {
      description:
        'The file base name which will be used as default theme name (default to "default").',
      default: 'default',
      type: 'string',
      minLength: 1,
    },
    onlyColor: {
      description:
        'Indicates whether only color property from css declaration should be extracted (default to true).',
      default: true,
      type: 'boolean',
    },
    filename: {
      description:
        'Specifies a custom filename template for the extracted theme css files using the query parameter (default to "[name].[contenthash:8].css").',
      default: '[name].[contenthash:8].css',
      oneOf: [{ type: 'string', minLength: 1 }, { instanceof: 'Function' }],
    },
    outputPath: {
      description:
        'Specifies a directory relative to webpack output path where the extracted theme css files will be placed (default to "themes").',
      default: 'themes',
      oneOf: [{ type: 'string', minLength: 1 }, { instanceof: 'Function' }],
    },
    publicPath: {
      description:
        'Specifies a custom public path for the extracted theme css files (default to "__webpack_public_path__ + outputPath").',
      // default: '__webpack_public_path__ + outputPath',
      oneOf: [{ type: 'string', minLength: 1 }, { instanceof: 'Function' }],
    },
    resourcePublicPath: {
      description:
        'Specifies a custom public path for the external resources like images, files, etc inside theme CSS.',
      oneOf: [{ type: 'string', minLength: 1 }, { instanceof: 'Function' }],
    },
    resourceFilter: {
      description: 'An RegExp or Function filter for the external resources.',
      oneOf: [{ instanceof: 'RegExp' }, { instanceof: 'Function' }],
    },
    esModule: {
      description: 'Indicates whether ECMAScript export syntax should be used (default to true).',
      default: true,
      type: 'boolean',
    },
    cssModules: {
      description:
        'If set true, the css modules will be used always. "auto" means ".module" suffix of file will enabled (default to "auto").',
      default: 'auto',
      oneOf: [{ type: 'boolean' }, { type: 'object' }, { enum: ['auto'] }],
    },
  },
}

type ExcludeNullableValueExcept<T, P extends keyof T> = Required<Omit<T, P>> & { [K in P]?: T[K] }
export type ValidPluginOptions = ExcludeNullableValueExcept<
  PluginOptions,
  'themeFilter' | 'publicPath' | 'resourcePublicPath' | 'resourceFilter'
>

//
export function getOptions(opts?: PluginOptions) {
  const options = Object.assign(
    {
      // themeFilter: null,
      // publicPath: '',
      // resourcePublicPath,
      // resourceFilter,
      themes: [],
      themeExportPath: defaultExportPath,
      defaultTheme: 'default',
      onlyColor: true,
      filename: '[name].[contenthash:8].chunk.css',
      outputPath: 'themes',
      esModule: true,
      cssModules: 'auto',
    },
    opts
  )
  validate(schema, options, {
    name: selfModuleName,
    baseDataPath: 'options',
  })
  const { themeExportPath, filename, defaultTheme } = options

  options.themeExportPath =
    themeExportPath === defaultExportPath
      ? resolveDefaultExportPath()
      : path.resolve(themeExportPath)

  Object.assign(options, {
    defaultTheme: defaultTheme.toLowerCase(),
    filename: (resourcePath: string, resourceQuery: string) => {
      const template =
        typeof filename === 'function' ? filename(resourcePath, resourceQuery) : filename
      if (typeof template !== 'string') {
        throw new Error('Invalid filename template')
      }
      // 确保文件后缀为.css，不然浏览器可能不会正常解析该样式文件
      return template.replace(/\s*(?:\.(?:[^.]+)?|)$/, '.css')
    },
  })

  return options as ValidPluginOptions
}

// 获取默认的导出路径
export function resolveDefaultExportPath() {
  try {
    return resolveModulePath(defaultExportPath, [fs.realpathSync(process.cwd())])
  } catch (e) {
    throw new Error(
      'There are no installed theme lib, please install "@ices/theme" first or set the option of "themeExportPath" to a customize theme module export path'
    )
  }
}
