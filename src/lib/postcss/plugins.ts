import * as path from 'path'
import valueParser from 'postcss-value-parser'
import { Rule } from 'postcss'
import { hasResourceURL } from '../colors'
import {
  determineCanUseAsThemeVarsByValue,
  ExtendPluginOptions,
  ExtendType,
  getTopScopeVariables,
  parseUrlPaths,
  pluginFactory,
  PluginOptions,
  ThemeLoaderData,
  toVarsDict,
} from './tools'
import {
  addTitleComment,
  createVarsRootRuleNode,
  getDeclProcessor,
  getProcessedPropertyValue,
  getSourceFile,
  getVarsMessages,
  setVarsMessage,
} from './helper'

// 抽取主题变量
// 消息 theme-vars 、 theme-root-vars
export function extractThemeVarsPlugin(options: PluginOptions) {
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

// 抽取顶层变量
// 消息 theme-vars、theme-root-vars
export function extractTopScopeVarsPlugin(options: PluginOptions) {
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

// 抽取上下文变量的插件（仅当前文件中声明的变量）
// 消息 theme-context
export function extractContextVarsPlugin(options: PluginOptions) {
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

// 抽取全局变量的插件（当前文件和导入文件中声明的变量）
export function extractVariablesPlugin(options: PluginOptions) {
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
export function extractURLVarsPlugin(options: PluginOptions) {
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
        const paths = parseUrlPaths(value)
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

// 抽取变量插件，应用于主题声明文件和普通样式文件，修改原样式文件
export function extractVarsPlugin(
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
      const node = createVarsRootRuleNode({
        ...pluginContext,
        asComment: !isThemeFile,
        properties,
        helper,
      })

      addTitleComment(node, helper)
    },
  }))
}

// 将变量声明为样式规则
export function exportVarsPlugin(
  options: ExtendPluginOptions<Required<Pick<PluginOptions, 'urlMessages' | 'variablesMessages'>>>
) {
  return pluginFactory(options, ({ regExps, vars }) => ({
    Once: async (root, helper) => {
      const { variables } = vars
      let rootRule: Rule | undefined

      for (const varsItem of variables.values()) {
        const { isRootDecl, originalName } = varsItem

        const decl = helper.decl({
          value: getProcessedPropertyValue(varsItem, vars, regExps, helper),
          prop: originalName,
        })

        if (!isRootDecl) {
          root.append(decl)
          continue
        }

        if (!rootRule) {
          rootRule = helper.rule({
            selector: ':root',
            nodes: [],
          })
          root.append(rootRule)
        }
        rootRule.append(decl)
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
      const context = path.dirname(sourceFile)

      for (const node of root.nodes) {
        if (node.type === 'atrule' && node.name === 'import') {
          const { params } = node
          if (hasResourceURL(params)) {
            continue
          }
          valueParser(node.params).walk((child) => {
            if (child.type === 'string' && child.value) {
              uris.add(child.value)
            }
          })
        }
      }
      for (const uri of uris) {
        await resolve(uri, sourceFile, context)
      }
    },
  }))
}
