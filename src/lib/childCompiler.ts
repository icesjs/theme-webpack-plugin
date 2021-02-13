import * as webpack from 'webpack'

const NodeTemplatePlugin = require('webpack/lib/node/NodeTemplatePlugin')
const NodeTargetPlugin = require('webpack/lib/node/NodeTargetPlugin')
const LoaderTargetPlugin = require('webpack/lib/LoaderTargetPlugin')
const LibraryTemplatePlugin = require('webpack/lib/LibraryTemplatePlugin')
const SingleEntryPlugin = require('webpack/lib/SingleEntryPlugin')
const MiniCssExtractPlugin = require('mini-css-extract-plugin')

export interface ChildCompiler extends webpack.Compiler {
  runAsChild(
    callback: (
      error: Error,
      entries: webpack.Chunk[] | undefined,
      compilation: webpack.compilation.Compilation
    ) => void
  ): void
  isChild(): true
}

export interface MainCompilation extends webpack.compilation.Compilation {
  createChildCompiler(
    compilerName: string,
    outputOptions: webpack.Output,
    plugins?: webpack.Plugin[]
  ): ChildCompiler
}

export type CompileResult = {
  [p: string]: { content: string; hash?: string; entry: webpack.Chunk }
}

class ThemeWebpackChildCompiler {
  private compilationStartedTimestamp: number | undefined
  private compilationEndedTimestamp: number | undefined
  private compilationPromise: Promise<CompileResult> | undefined
  private fileDependencies:
    | {
        fileDependencies: string[]
        contextDependencies: string[]
        missingDependencies: string[]
      }
    | undefined
  constructor(private readonly themeFile: string) {}

  getFileDependencies() {
    return this.fileDependencies
  }

  isCompiling() {
    return !this.didCompile() && this.compilationStartedTimestamp !== undefined
  }

  didCompile() {
    return this.compilationEndedTimestamp !== undefined
  }

  compile(mainCompilation: MainCompilation) {
    if (this.compilationPromise) {
      return this.compilationPromise
    }

    const compilerName = ThemeWebpackChildCompiler.name

    const outputOptions = {
      filename: '__child-[name]',
      publicPath: mainCompilation.outputOptions.publicPath,
    }

    const childCompiler = mainCompilation.createChildCompiler(compilerName, outputOptions)
    childCompiler.context = mainCompilation.compiler.context

    new NodeTemplatePlugin(outputOptions).apply(childCompiler)
    new NodeTargetPlugin().apply(childCompiler)
    new LibraryTemplatePlugin('THEME_WEBPACK_PLUGIN_RESULT', 'var').apply(childCompiler)
    new LoaderTargetPlugin('node').apply(childCompiler)
    new MiniCssExtractPlugin({}).apply(childCompiler)
    new SingleEntryPlugin(childCompiler.context, this.themeFile, compilerName).apply(childCompiler)

    this.compilationStartedTimestamp = Date.now()
    this.compilationPromise = new Promise<CompileResult>((resolve, reject) => {
      childCompiler.runAsChild((err, entries, childCompilation) => {
        const compiledThemes = entries
          ? this.extractFilesFromCompilation(
              mainCompilation,
              childCompilation,
              outputOptions.filename,
              entries
            )
          : []

        if (entries) {
          this.fileDependencies = {
            fileDependencies: Array.from(childCompilation.fileDependencies),
            contextDependencies: Array.from(childCompilation.contextDependencies),
            missingDependencies: Array.from(childCompilation.missingDependencies),
          }
        }

        if (childCompilation && childCompilation.errors && childCompilation.errors.length) {
          const errorDetails = childCompilation.errors
            .map((error) => {
              let message = error.message
              if (error.error) {
                message += ':\n' + error.error
              }
              if (error.stack) {
                message += '\n' + error.stack
              }
              return message
            })
            .join('\n')
          reject(new Error('Child compilation failed:\n' + errorDetails))
          return
        }

        if (err) {
          reject(err)
          return
        }

        const result = {} as CompileResult
        compiledThemes.forEach((templateSource, entryIndex) => {
          result[this.themeFile[entryIndex]] = {
            content: templateSource,
            hash: childCompilation.hash,
            entry: entries![entryIndex],
          }
        })
        this.compilationEndedTimestamp = Date.now()
        resolve(result)
      })
    })

    return this.compilationPromise
  }

  extractFilesFromCompilation(
    mainCompilation: MainCompilation,
    childCompilation: webpack.compilation.Compilation,
    filename: string,
    childEntryChunks: webpack.Chunk[]
  ) {
    const helperAssetNames = childEntryChunks.map((entryChunk, index) => {
      const entryConfig = {
        hash: childCompilation.hash,
        chunk: entryChunk,
        name: `${ThemeWebpackChildCompiler.name}_${index}`,
      }

      return mainCompilation.getPath
        ? mainCompilation.getPath(filename, entryConfig)
        : (mainCompilation.mainTemplate as any).getAssetPath(filename, entryConfig)
    })

    helperAssetNames.forEach((helperFileName) => {
      delete mainCompilation.assets[helperFileName]
    })

    return helperAssetNames.map((helperFileName) => {
      return childCompilation.assets[helperFileName].source()
    })
  }
}

export default ThemeWebpackChildCompiler
