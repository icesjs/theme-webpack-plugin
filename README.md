# @ices/theme-webpack-plugin

## A library for process themes.

## How does it work?

### Don't use build plugin

This is your style file.

```css
/* styles/app.css */

body {
  background-color: #0d1117;
}
```

Let's assume a scenario.

You want your page background color to be able to switch according to user preferences.

Then you use a variable to separate the background-color styles.

```css
/* styles/app.css */

@import '../themes/dark.css';

body {
  background-color: var(--body-background-color);
}
```

You create a theme variable declaration file named by dark.

```css
/* themes/dark.css */

:root {
  --body-background-color: #0d1117;
}
```

So far, it's all as you think, your page has a dark background color.

Next, you create a white style theme file named by light.

```css
/* themes/light.css */

:root {
  --body-background-color: #fff;
}
```

If you don't use tools to make these variables work, you need to add additional attributes to isolate them.

Then you need to change your code to use these variables. Just like this:

```css
/* styles/app.css */
@import '../themes/dark.css';
@import '../themes/light.css';
body {
  background-color: var(--body-background-color);
}

/* themes/dark.css */
[data-theme='dark']:root {
  --body-background-color: #0d1117;
}

/* themes/light.css */
[data-theme='light']:root {
  --body-background-color: #fff;
}
```

Moreover, you need to write some javascript code to dynamically switch theme attributes on the page.

If you use CSS preprocessor like scss or less, the situation may be more complicated.

```less
/* styles/app.less */
@import '../themes/dark.less';
body {
  background-color: @body-background-color;
}

/* themes/dark.less */
@body-background-color: #0d1117;
```

If there are some special style rules that need to be changed with the theme,
you don't even have a good way to make them dynamic.

```css
/* themes/dark.css */

/* it seems difficult to switch the rule */
@font-face {
  font-family: 'iconfont';
  src: url('iconfont.eot');
}
```

### Use build plugin

This is you style files:

```less
/* styles/app.less */

@import '../themes/dark.less';

body {
  background-color: @body-background-color;
}

button {
  border: 1px solid @button-border-color;
}
```

```less
/* themes/dark.less */

@body-background-color: #0d1117;
@button-border-color: #30363d;

aside {
  background-color: #161b22;
}

@media (max-width: 720px) {
  aside {
    display: none;
  }
}

@font-face {
  font-family: 'iconfont';
  src: url('iconfont.eot');
}
```

Then compile and converted to:

```css
/* styles/app.css */

body {
  background-color: var(--body-background-color-c4ba, #0d1117);
}

button {
  border: 1px solid var(--button-border-color-0c8c, #30363d);
}
```

```css
/* themes/dark.css */

:root[data-theme='dark'] {
  --body-background-color-c4ba: #0d1117;
  --button-border-color-0c8c: #30363d;
}

:root[data-theme='dark'] aside {
  background-color: #161b22;
}

@media (max-width: 720px) {
  :root[data-theme='dark'] aside {
    display: none;
  }
}
```

```html
<style type="text/css">
  /* with the theme switch automatically injected into the page */
  @font-face {
    font-family: 'iconfont';
    src: url('iconfont.eot');
  }
</style>
```

You can create new themes without changing the previous code.

```less
/* themes/light.less */

@body-background-color: #fff;
@button-border-color: #fff;

aside {
  background-color: #fff;
}

@media (max-width: 720px) {
  aside {
    display: none;
  }
}
```

Compile and converted to:

```css
/* themes/light.css */

:root[data-theme='light'] {
  --body-background-color-c4ba: #fff;
  --button-border-color-0c8c: #fff;
}

:root[data-theme='light'] aside {
  background-color: #fff;
}

@media (max-width: 720px) {
  :root[data-theme='light'] aside {
    display: none;
  }
}
```

You can use the theme management component out of the box.

```tsx
import { useCallback } from 'react'
import { useTheme } from '@ices/theme/react'

export function ToggleTheme() {
  // use react hook to manage theme
  const [theme, themeList, changeTheme] = useTheme()
  const handleChange = useCallback((event) => changeTheme(event.target.value), [changeTheme])
  return (
    <select value={theme} onChange={handleChange}>
      {themeList.map((theme) => (
        <option value={theme} key={theme}>
          {theme}
        </option>
      ))}
    </select>
  )
}
```

Not use some lib:

```ts
import themeManager from '@ices/theme'
const themeList = themeManager.themeList
const currentTheme = themeManager.theme

// add event listener
themeManager.on('change', ({ data: { current, previous } }) => {
  // do something
})
const unsubscribe = themeManager.subscribe('change', ({ data: { current, previous } }) => {
  // do something
})

// use property setter to change theme
themeManager.theme = themeList[1]
// use promise when theme changed
themeManager.changeTheme(themeList[1]).then((theme) => {
  // do something
})
```

You can publish the theme file as separated css file when set the <code>extract</code> option to <code>true</code>.

You can use <code>less</code>、<code>scss</code>、<code>sass</code> or standard <code>css custom properties</code> to declare the theme variables.

### With that, what do you need to do?

Just add the <code>@ices/theme-webpack-plugin</code> to you webpack plugin configuration, and set the theme filepath of glob patterns.

If you remove this plug-in in the future, your code will not be affected, but you will not be able to switch themes.

## Usage

```shell
yarn add @ices/theme-webpack-plugin -D
yarn add @ices/theme

or

npm i @ices/theme-webpack-plugin -D
npm i @ices/theme
```

```js
// webpack.config.js
const ThemeWebpackPlugin = require('@ices/theme-webpack-plugin')

module.exports = {
  plugins: [
    // use this plugin, then auto inject loader
    new ThemeWebpackPlugin({
      themes: ['src/themes/*.scss'],
      defaultTheme: 'dark',
    }),
  ],
}
```

```tsx
// React
// ChooseTheme.tsx
import * as React from 'react'
import { useCallback } from 'react'
import { useTheme } from '@ices/theme/react'

function ChooseTheme() {
  const [theme, themeList, changeTheme] = useTheme(
    localStorage.getItem('preferred-theme-name') || ''
  )
  const handleChange = useCallback(
    (event) => {
      changeTheme(event.target.value).then((theme) => {
        localStorage.setItem('preferred-theme-name', theme)
      })
    },
    [changeTheme]
  )

  return (
    <select value={theme} onChange={handleChange}>
      {themeList.map((theme) => (
        <option key={theme} value={theme}>
          {theme}
        </option>
      ))}
    </select>
  )
}

export default ChooseTheme
```

```vue
<template>
  <select v-model="theme">
    <option v-for="theme in themeList" :key="theme" :value="theme">
      {{ theme }}
    </option>
  </select>
</template>
<script>
// Vue
// ChooseTheme.vue
import themeManager from '@ices/theme'
export default {
  data() {
    return {
      theme: localStorage.getItem('preferred-theme-name') || themeManager.theme,
      themeList: themeManager.themeList,
    }
  },
  watch: {
    theme(value) {
      themeManager
        .changeTheme(value)
        .then((theme) => {
          localStorage.setItem('preferred-theme-name', theme)
        })
        .finally(() => {
          this.theme = themeManager.theme
        })
    },
  },
}
</script>
```

## Playground

[Codesandbox](https://codesandbox.io/s/ices-theme-webpack-plugin-examples-lqg3r)

## Support

### syntax

- SCSS
- SASS
- LESS
- CSS Custom Property

### build tools

- Create React App
- Vue CLI
- Others Use Webpack

### webpack

- v4+
- v5+

### others

- Relative url rewrite
- Publish as a separate theme style file
- Theme component out of the box

## Options

```ts
export interface PluginOptions {
  /**
   * The file base name which will be used as default theme name (default to "default").
   */
  defaultTheme?: string

  /**
   * Indicates whether ECMAScript export syntax should be used (default to true).
   */
  esModule?: boolean

  /**
   * Indicates whether split theme files to separated chunk file (default to false).
   */
  extract?: boolean

  /**
   * Specifies a custom filename template for the extracted theme css files using the query parameter (default to "[name].[contenthash:8].css").
   * (valid when extract set to true)
   */
  filename?: string | ((resourcePath: string, resourceQuery: string) => string)

  /**
   * A function to return the css content from javascript module.
   * @param exports module exports
   * @param resourcePath absoulute filepath for the module
   */
  getCssContent?: (exports: any, resourcePath: string) => string | PromiseLike<string>

  /**
   * A function to determine the requested resource is a css module.
   * @param module
   */
  isStyleModule?: (module: {
    request: string
    resourcePath: string
    resourceQuery: string
    context: string
    issuer: string
    query: {
      [p: string]: string | boolean
    }
  }) => boolean | string

  /**
   * Indicates whether only color property from css declaration should be extracted (default to true).
   */
  onlyColor?: boolean

  /**
   * Specifies a directory relative to webpack output path where the extracted theme css files will be placed (default to "themes").
   * (valid when extract set to true)
   */
  outputPath?: string | ((url: string, resourcePath: string, projectContext: string) => string)

  /**
   * Specifies a custom public path for the extracted theme css files (default to "__webpack_public_path__ + outputPath").
   * (valid when extract set to true)
   */
  publicPath?: string | ((url: string, resourcePath: string, projectContext: string) => string)

  /**
   * An RegExp or Function filter for the external resources.
   * (valid when extract set to true)
   */
  resourceFilter?: ((externalFile: string, resourcePath: string) => boolean) | RegExp

  /**
   * Specifies a custom public path for the external resources like images, files, etc inside theme CSS.
   * (valid when extract set to true)
   */
  resourcePublicPath?:
    | string
    | ((
        externalFile: string,
        resourcePath: string,
        projectContext: string
      ) => string | PromiseLike<string>)

  /**
   * The attribute name for root element (html) to set the theme name (default to "data-theme").
   */
  themeAttrName?: string

  /**
   * A file for output the content of theme module (default to "@ices/theme/dist/theme.js").
   */
  themeExportPath?: string

  /**
   * An RegExp or Function filter for the theme file.
   */
  themeFilter?: ((path: string) => boolean) | RegExp

  /**
   * Directories or Files should be used as theme file. Can use glob pattern.
   */
  themes?: string | string[]
}
```

### 选项说明

```ts
export interface PluginOptions {
  /**
   * 主题变量声明文件。可使用 glob 语法。
   * 主题文件中也可以声明非变量的内容，以及导入其他的样式文件。
   * 构建过程中，主题插件会对声明的内容进行拆分处理。
   * 被导入的变量中可以包含 url 相对地址，主题插件会对变量中包含的 url 相对地址进行重写，
   * 确保在导入文件中这些相对地址是正确引用目标资源的。
   */
  themes?: string | string[]

  /**
   * 一个函数，或正则表达式，用于过滤匹配到的主题文件。
   * 默认过滤 .css, .sass, .scss, .less
   * @param path 匹配到的文件路径
   */
  themeFilter?: ((path: string) => boolean) | RegExp

  /**
   * 主题内容导出路径。一般不需要配置这项。默认为 @ices/theme/dist/theme.js 。
   * 如果默认的主题管理包 @ices/theme 不符合你的主题管理要求，
   * 你需要使用自己的主题管理器，则可以通过这个配置项指定一个路径地址。
   * 主题插件会将导出的内容输出到这个路径指定的文件中。
   * 其默认导出为一个包含主题描述对象的数组，其格式为：
   *
   * // 默认导出为一个数组，数组元素为一个主题对象
   * [{
   *   name: string, // 主题的名称，来自于主题文件名
   *   activated: boolean,  // 主题是否处于激活状态
   *   // 激活主题的方法，返回值Promise resolve参数为当前主题名称，reject参数为异常对象
   *   activate: () => Promise<string>
   * }]
   *
   * 然后你就可以通过自己的代码来导入这个文件，并通过主题对象的 activate() 方法来激活该主题了。
   * 请确保此路径指定的文件是可写的。
   * 注意，activate() 方法返回的是一个 Promise 对象。
   */
  themeExportPath?: string

  /**
   * 默认的主题名。建议始终设置默认的主题。
   * 默认的主题不会抽离成单独的css文件。
   * 如果没有指定默认的主题，则名称为 default 的主题，或者第一个匹配到主题将作为默认的主题。
   */
  defaultTheme?: string

  /**
   * 是否仅抽取来自于主题文件中声明的代表颜色的变量。默认为true。
   * 主题插件会根据实际可包含颜色定义的样式属性声明（比如 border、background），
   * 检查其值是否引用了变量，并根据引用变量的上下文环境，计算出其真实值，然后检查其真实值是否是一个颜色值。
   * 颜色值包括颜色名称（比如 green 代表绿色，transparent 代表透明色），
   * 以及符合 Web 标准的颜色代码
   * （比如 #fff、rgb、rgba、hsl）等等。
   * 另外，图片属性也会被当成“颜色值”来处理。也即可以通过主题来更换背景图片。
   * 如果变量的引用不是来自于主题文件，则此变量不会被抽取，所以，你的样式文件还是需要导入要使用的主题样式文件的。
   * 可被当成主题变量抽取的变量声明，含特定语法的变量声明（比如：$scss-var:xxx、@less-var:xxx）
   * 以及定义在:root规则上的css自定义属性（:root{--my-prop:xxx}）
   * 注意，如果你在当前文件中声明了一个和导入变量同名的变量，则主题插件不会将这个变量提取，
   * 也就是说仅有来自于主题文件(含主题文件自身导入的其他文件)中的变量才会被提取。
   * 有一个特殊情况是，如果本地变量值里又使用了其他的变量，而这些其他的变量都来自于主题文件，则该本地变量同样会被提取。
   * 比如：$my-border：1px solid $color-from-dark-theme，在这个本地变量$my-border里面
   * 又引用了一个来自主题里面的变量$color-from-dark-theme，因为所有变量的引用
   * 都可以计算出其来源，并确定都是来源于主题文件，所以引用了$my-border变量的声明值，也会被当成动态主题提取。
   * 一般你只需要导入默认的主题样式文件即可，默认的主题样式文件里可声明所有需要用到的主题变量，
   * 当然如果你不导入主题样式文件，编译特定语法的样式文件（比如 xxx.scss）也会报错，因为找不到对应的变量，
   * 所以无论如何你还是要在你的样式文件里导入至少一个主题声明文件的。
   * 被抽取的变量，会将其当前已声明的值赋为var(--xxx)变量引用的默认值，
   * 如果动态插入页面的那个主题里没有你的那个变量，也会使用你在写代码的时候，所引用变量的那个值。
   * 所以你不需要担心在浏览器端运行时，动态引用的主题里是否有你要的那个变量。
   */
  onlyColor?: boolean

  /**
   * 主题文件的名称模板。extract 配置项为 true 时有效。
   * 默认为 [name].[contenthash:8].css
   */
  filename?: string | ((resourcePath: string, resourceQuery: string) => string)

  /**
   * 主题文件发布目录。相对于构建输出目录。extract 配置项为 true 时有效。
   * 默认为 themes。
   */
  outputPath?: string | ((url: string, resourcePath: string, projectContext: string) => string)

  /**
   * 主题文件的发布部署路径。extract 配置项为 true 时有效。
   * 默认为 __webpack_public_path__ + outputPath
   * 这个属性的值影响js代码里面保存的主题样式文件的路径值。js代码里动态插入link标签到页面上时，标签的href引用地址就与这个属性有关。
   */
  publicPath?: string | ((url: string, resourcePath: string, projectContext: string) => string)

  /**
   * 资源文件的相对部署路径。资源文件指在主题文件中引用的url资源，比如图片，字体等。
   * extract 配置项为 true 时有效。
   * 默认为从主题文件本身的输出目录回退到构建输出目录的相对路径。因为资源文件一般是相对于主题文件本身路径引用的，所以是相对路径。比如，
   * 主题文件相对构建目录输出路径为 static/themes/dark.css，则资源部署路径被设置为 ../../
   * 如果默认的设置不符合需求，可以通过此项配置设置一个固定的值，或者使用一个函数根据参数返回资源的相对部署路径。
   * 注意，这个配置项影响的是样式文件自身内部对图片、字体等外部资源的引用关系。各种乱七八糟的路径很容易搞混淆搞错，要特别注意。
   * 还有一点是，默认的主题文件是直接打包到应用的样式文件里去的，对外部资源的引用处理
   * 一般由css-loader、url-loader以及file-loader处理，而没有经过主题插件的处理。
   * 如果默认主题文件里也有图片等外部资源引用，而且需要自定义资源发布部署路径时，需要到应用自身的样式模块配置(一般是loader配置)里去自定义。
   */
  resourcePublicPath?:
    | string
    | ((
        externalFile: string,
        resourcePath: string,
        projectContext: string
      ) => string | PromiseLike<string>)

  /**
   * 需要计算相对部署路径的资源文件的筛选规则。默认根据资源扩展名称筛选图片、字体等文件。
   * extract 配置项为 true 时有效。
   */
  resourceFilter?: ((externalFile: string, resourcePath: string) => boolean) | RegExp

  /**
   * 生成的代码是否使用esModule语法。
   * 默认为true。
   */
  esModule?: boolean

  /**
   * 是否将除默认主题外的主题抽取成单独的文件发布（也即常说的split code）。默认为 false 。
   * 如果不抽取，则所有主题样式都默认与主样式文件打包在一起，并以不同属性值作为命名空间进行区分。
   * 如果主题文件里不仅仅只是变量声明，还包含其他的一些非变量类样式，建议将主题文件单独发布。
   * 如果主题样式本身体积较大，也建议单独发布。
   */
  extract?: boolean

  /**
   * 自定义文档根节点 html 元素上设置主题的属性名称。extract 配置项为 false 时有效。
   * 默认为 data-theme 。
   */
  themeAttrName?: string

  /**
   * 自定义获取css内容的函数。 extract 配置项为 true 时有效。
   * 一般情况下，css会被loader转换为js模块以便被webpack打包使用，
   * 如果需要单独以css文件形式发布css模块，则需要先将css内容从js模块里面分离出来，再以css chunk资源文件形式发布。
   * 常用的分离css内容的插件，有 mini-css-extract-plugin、extract-loader、extract-text-webpack-plugin（已不被建议使用）等。
   * 因对分离的css资源，需要随主题切换进行精细化的加载卸载处理，mini-css-extract-plugin 无法满足要求，所以主题插件自身也提供
   * 了css资源从代码里分离的能力。
   * 从js代码里分离出css内容，需要以webpack模块上下文来运行js模块代码，并从js模块的导出对象里面获取原始css字符串。
   * 默认情况下主题插件假设前置处理css模块转换的loader为css-loader，css-loader的导出内容是固定的格式
   * （一个数组，1号索引为原始css内容，数组自身有toString方法，将css内容及源码映射文件以字符串形式导出来）。
   * 如果你使用了其他的loader来模块化css，可配置此项，将css内容从模块的导出对象里获取并传递给主题插件的loader。
   * @param exports 样式模块转换为js模块后的导出对象。
   * @param resourcePath 被处理样式文件的绝对路径。
   */
  getCssContent?: (exports: any, resourcePath: string) => string | PromiseLike<string>

  /**
   * 根据请求参数，判断非标准css文件名称的请求是不是一个css模块请求。
   * 一般情况下，主题插件会自动为所有已经配置的模块规则中的css模块，添加正确的变量抽取loader，而对于非标准的css模块就无能为力了。
   * 比如在vue组件中，css是通过组件中的<style>标签嵌入的，对css模块的请求是由vue-style-loader动态生成的，
   * 这时候通过模块rule配置的loader，就没办法直接应用于这个动态生成的css模块请求。
   * 通过此项配置一个判断函数，就能够为这些非标准css模块后缀名的模块，应用变量抽取loader。
   * 该项配置的默认值是一个检测是否是vue组件css模块请求的判断函数，如果你需要自己来判断，或者默认的判断不准确，则可以配置此项。
   * 判断函数可以返回一个布尔值，或者字符串，返回字符串时，可以精确指定该模块的css语法类型(css、less、scss、sass)，
   * 返回布尔值，则插件会先根据资源请求中应用的loader名称来判断模块语法类型，判断不出时则备选为普通css语法格式。
   * 注意，标准的常见css模块名称后缀(.css、.less、.scss、.sass)，不会进入到这个判断函数，
   * 而且作为默认，在进入到该判断函数前，都会先调用 ThemePlugin 上的静态方法 shouldResolveStyleModule()
   * 如果你需要修改这个默认的筛选行为，可以从导出的  ThemePlugin  上覆盖这个静态方法。比如：
   *
   * require('@ices/theme-webpack-plugin').ThemePlugin.shouldResolveStyleModule = (resourcePath, resourceQuery) => true
   *
   * 另外，主题插件未处理stylus语法格式。
   */
  isStyleModule?: (module: {
    request: string
    resourcePath: string
    resourceQuery: string
    context: string
    issuer: string
    query: { [p: string]: string | boolean }
  }) => boolean | string
}
```

## Related

[\@ices/theme](https://www.npmjs.com/package/@ices/theme)
