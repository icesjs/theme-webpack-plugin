# @ices/theme-webpack-plugin

## A library for process themes.

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
    // that's all
    new ThemeWebpackPlugin({
      themes: ['src/themes/*.scss'],
      defaultTheme: 'dark',
    }),
  ],
}
```

## Demo

[LiveDemo](https://codesandbox.io/s/ices-theme-webpack-plugin-examples-lqg3r)

## Support

### Syntax

- SCSS
- SASS
- LESS
- CSS Custom property

### CLI

- Create React App
- Vue CLI
- others use webpack

### Webpack

- v4+
- v5+

### related

[@ices/theme](https://www.npmjs.com/package/@ices/theme)
