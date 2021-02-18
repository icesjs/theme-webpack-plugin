import * as path from 'path'
import valueParser from 'postcss-value-parser'
import { Node } from 'postcss'
import { hasResourceURL } from '../colors'
import {
  determineCanUseAsThemeVarsByValue,
  ExtendPluginOptions,
  ExtendType,
  getTopScopeVariables,
  insertRawBefore,
  parseURLPaths,
  pluginFactory,
  PluginOptions,
  ThemeLoaderData,
  toVarsDict,
  VarsDictItem,
} from './tools'
import {
  addTitleComment,
  createDeclarations,
  createRootRule,
  createVarsRootRule,
  getDeclProcessor,
  getSourceFile,
  getVarsMessages,
  setVarsMessage,
} from './helper'

// 消息 theme-vars 、 theme-root-vars
export function defineThemeVariablesPlugin(options: PluginOptions) {
  return pluginFactory(options, ({ regExps, onlyColor }) => ({
    OnceExit: async (root, helper) => {
      const variables = getTopScopeVariables(root, regExps)
      for (const { decl, value, isRootDecl, ...rest } of variables.values()) {
        if (determineCanUseAsThemeVarsByValue(value, onlyColor)) {
          const type = isRootDecl ? 'theme-root-vars' : 'theme-vars'
          setVarsMessage({ ...rest, value, isRootDecl, helper, type })
        }
      }
    },
  }))
}

// 消息 theme-vars、theme-root-vars
export function defineTopScopeVarsPlugin(options: PluginOptions) {
  return pluginFactory(options, ({ regExps }) => ({
    OnceExit: async (root, helper) => {
      for (const vars of getTopScopeVariables(root, regExps).values()) {
        const { decl, isRootDecl, ...rest } = vars
        const type = isRootDecl ? 'theme-root-vars' : 'theme-vars'
        setVarsMessage({ ...rest, isRootDecl, helper, type })
      }
    },
  }))
}

// 消息 theme-context
export function defineContextVarsPlugin(options: PluginOptions) {
  return pluginFactory(options, ({ regExps }) => ({
    Once: async (root, helper) => {
      // 这里不对值进行引用解析，是因为此时并不知道上下文中所有可用的变量
      const vars = getTopScopeVariables(root, regExps, null, false)
      for (const { decl, ...rest } of vars.values()) {
        setVarsMessage({ ...rest, helper, type: 'theme-context-vars' })
      }
    },
  }))
}

// 完善本地变量的值解析
export function resolveContextVarsPlugin(options: PluginOptions) {
  return pluginFactory(options, ({ regExps }) => ({
    OnceExit: async (root, helper) => {
      const variables = getTopScopeVariables(root, regExps)
      const messages = helper.result.messages
      for (const msg of getVarsMessages(messages, 'theme-context-vars')) {
        const parsedVars = variables.get(msg.originalName)
        if (parsedVars) {
          // 补充本地变量的解析值
          const { value, dependencies } = parsedVars
          msg.dependencies = dependencies
          msg.value = value
          continue
        }
        // 清除无效的本地变量
        messages.splice(messages.indexOf(msg), 1)
      }
    },
  }))
}

// 提取外部资源引用URL变量
export function defineURLVarsPlugin(options: PluginOptions) {
  return pluginFactory(options, ({ regExps }) => ({
    OnceExit: async (root, helper) => {
      const sourceFile = getSourceFile(helper, root)
      if (!sourceFile) {
        return
      }
      for (const vars of getTopScopeVariables(root, regExps).values()) {
        const { decl, value, from, ...rest } = vars
        if (!hasResourceURL(value)) {
          continue
        }
        const paths = parseURLPaths(value, true)
        if (paths.size) {
          setVarsMessage({
            ...rest,
            value,
            helper,
            type: 'theme-url-vars',
            from: from || sourceFile,
            data: paths,
          })
        }
      }
    },
  }))
}

// 创建主题属性声明规则，修改原样式文件
export function makeThemeVarsDeclPlugin(
  options: ExtendPluginOptions<ExtendType<Required<ThemeLoaderData>, { isThemeFile: boolean }>>
) {
  return pluginFactory(options, ({ isThemeFile, ...pluginContext }) => ({
    OnceExit: async (root, helper) => {
      // 处理属性值
      root.walkDecls(getDeclProcessor({ ...pluginContext, helper }))

      // 需要写入的:root规则属性
      const properties = !isThemeFile
        ? toVarsDict(getVarsMessages(helper.result.messages, 'theme-prop-vars'))
        : pluginContext.vars.variables

      // 写入:root规则声明到文件
      const node = createVarsRootRule({
        ...pluginContext,
        asComment: !isThemeFile,
        properties,
        helper,
      })

      if (node && isThemeFile) {
        addTitleComment(node, helper)
      }
    },
  }))
}

// 创建顶层作用域变量声明规则
export function makeTopScopeVarsDeclPlugin(
  options: ExtendPluginOptions<Required<Pick<PluginOptions, 'urlMessages' | 'variablesMessages'>>>
) {
  return pluginFactory(options, ({ ...pluginContext }) => ({
    Once: async (root, helper) => {
      const { vars, syntax, regExps } = pluginContext
      const properties = new Map<string, VarsDictItem>()
      const rootProperties = new Map<string, VarsDictItem>()
      for (const varsItem of vars.variables.values()) {
        const { ident, isRootDecl } = varsItem
        ;(isRootDecl ? rootProperties : properties).set(ident, varsItem)
      }
      if (properties.size) {
        root.append(createDeclarations({ ...pluginContext, properties, helper }, false, 0).decls)
      }
      if (rootProperties.size) {
        const decls = createDeclarations(
          { ...pluginContext, properties: rootProperties, helper },
          false,
          2
        ).decls
        root.append(createRootRule(decls, syntax, regExps, helper))
      }
      if (root.first) {
        addTitleComment(root.first, helper, getSourceFile(helper, root))
      }
    },
  }))
}

// 解析导入路径
export function resolveImportPlugin(
  options: ExtendPluginOptions<{
    resolve: (id: string, sourceFile: string, context: string) => any
  }>
) {
  return pluginFactory(options, ({ resolve }) => ({
    Once: async (root, helper) => {
      const uris = new Set<string>()
      const sourceFile = getSourceFile(helper, root)
      if (!sourceFile) {
        return
      }
      for (const node of root.nodes) {
        if (node.type === 'atrule' && node.name === 'import' && node.params) {
          const { params } = node
          const nodes = valueParser(params).nodes || []
          if (nodes.length === 1 && nodes[0].type === 'string') {
            if (nodes[0].value) {
              uris.add(nodes[0].value)
            }
          } else {
            for (const uri of parseURLPaths(nodes, false)) {
              uris.add(uri)
            }
          }
        }
      }
      const context = path.dirname(sourceFile)
      for (const uri of uris) {
        await resolve(uri, sourceFile, context)
      }
    },
  }))
}

// 保留节点的格式
export function preserveRawStylePlugin(options: PluginOptions) {
  return pluginFactory(options, ({}) => ({
    Once: async (root) => {
      root.append = new Proxy(root.append, {
        apply(target, thisArg, argArray: Node[]) {
          const nodes = [...argArray]
          const res = Reflect.apply(target, thisArg, argArray)
          for (const node of nodes) {
            if (root.first !== node) {
              insertRawBefore(node, 2)
            }
          }
          return res
        },
      })
    },
  }))
}
