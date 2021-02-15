import { Comment, Rule } from 'postcss'
import { hasResourceURL } from '../colors'
import {
  determineCanUseAsThemeVarsByValue,
  ExtractVarsPluginOptions,
  getTopScopeVariables,
  parseUrlPaths,
  pluginFactory,
  toVarsDict,
} from './tools'
import {
  addTitleComment,
  createVarsRootRuleNode,
  getDeclProcessor,
  getVarsMessages,
  setVarsMessage,
} from './helper'

// 抽取主题变量。
// 此插件在pitch阶段执行。
// 需要atImport插件先执行。
// 消息 theme-vars 、 theme-root-vars。
export function extractThemeVarsPlugin(options: ExtractVarsPluginOptions) {
  return pluginFactory(options, ({ regExps, onlyColor }) => ({
    OnceExit: async (root, helper) => {
      const variables = getTopScopeVariables(root, regExps)
      // 处理顶层变量
      for (const { value, isRootDecl, ...rest } of variables.values()) {
        if (determineCanUseAsThemeVarsByValue(value, onlyColor)) {
          setVarsMessage({
            ...rest,
            value,
            isRootDecl,
            helper,
            type: isRootDecl ? 'theme-root-vars' : 'theme-vars',
          })
        }
      }
    },
  }))
}

// 抽取上下文变量的插件（仅当前文件中声明的变量）。
// 此插件在pitch阶段执行。
// 需要在atImport插件之前执行。
// 消息 theme-context。
export function extractContextVarsPlugin(options: ExtractVarsPluginOptions) {
  return pluginFactory(options, ({ regExps }) => ({
    Once: async (root, helper) => {
      // 这里不对值进行引用解析，是因为此时并不知道上下文中所有可用的变量
      // 如果现在就进行解析，则如果本地变量引用了从其他文件导入的变量，则会引用失败
      const context = getTopScopeVariables(root, regExps, null, false)
      for (const { originalValue, ...rest } of context.values()) {
        setVarsMessage({
          ...rest,
          originalValue,
          // 这里当前值没有作解析处理，期待在extractVariablesPlugin里面进行
          // 得等到导入文件解析完成后，再进行解析
          value: originalValue,
          helper,
          type: 'theme-context',
        })
      }
    },
  }))
}

// 抽取全局变量的插件（当前文件和导入文件中声明的变量）。
// 此插件在pitch阶段执行。
// 需要atImport插件先执行。
export function extractVariablesPlugin(options: ExtractVarsPluginOptions) {
  return pluginFactory(options, ({ regExps }) => ({
    OnceExit: async (root, helper) => {
      const variables = getTopScopeVariables(root, regExps)
      const messages = helper.result.messages
      for (const msg of getVarsMessages(messages, 'theme-context')) {
        const parsedVariable = variables.get(msg.originalName)
        // 重设当前上下文本地变量的值
        if (parsedVariable) {
          // 本地变量有可能引用的所有变量全部来自主题变量
          // 这种情况下，该本地变量也应该算成主题变量
          // （类似于在当前文件中重命名了主题变量）
          // 所以需要检查下本地变量的依赖变量是否全部来自主题变量
          const { value, dependencies } = parsedVariable
          // 这里还无法获取主题中的变量声明
          // 更新消息字段，将依赖信息添加进去
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

// 抽取顶层变量声明。
// 不修改原样式文件。
// 需要在 atImport 插件后面执行。
// 消息：theme-vars、theme-root-vars
export function extractTopScopeVarsPlugin(options: ExtractVarsPluginOptions) {
  return pluginFactory(options, ({ regExps, parseValue = true }) => ({
    OnceExit: async (root, helper) => {
      for (const vars of getTopScopeVariables(root, regExps, null, parseValue).values()) {
        const { isRootDecl } = vars
        setVarsMessage({
          ...vars,
          helper,
          type: isRootDecl ? 'theme-root-vars' : 'theme-vars',
        })
      }
    },
  }))
}

// 抽取变量插件，应用于主题声明文件和普通样式文件。
// 此插件在 normal 阶段执行。
// 不需要其他插件辅助。
// 修改原样式文件。
export function extractVarsPlugin(options: ExtractVarsPluginOptions) {
  return pluginFactory(options, ({ regExps, onlyColor, vars, syntax }) => ({
    OnceExit: async (root, helper) => {
      const { themeVars, variables, context, references, urlVars } = vars
      let node: Rule | Comment | null = null
      if (themeVars) {
        node = createVarsRootRuleNode({
          properties: themeVars,
          urlVars,
          syntax,
          regExps,
          helper,
        })
      } else if (variables && context) {
        // 进行迭代
        root.walkDecls(
          getDeclProcessor(
            onlyColor,
            syntax,
            { variables, context, urlVars, references },
            regExps,
            helper
          )
        )

        // 这里仅生成变量声明注释，方便调试
        // 实际的变量由Theme模块生成并动态插入到页面中
        node = createVarsRootRuleNode({
          properties: toVarsDict(getVarsMessages(helper.result.messages, 'theme-vars'), false)!,
          asComment: true, // 以注释形式插入
          urlVars,
          syntax,
          regExps,
          helper,
        })
      }

      if (node) {
        // 添加注释
        addTitleComment(node, helper)
      }
    },
  }))
}

// 用于抽取变量并创建新的样式文件
// 将变量声明为样式规则
export function exportVarsPlugin(options: ExtractVarsPluginOptions) {
  return pluginFactory(options, ({ messages }) => ({
    Once: async (root, helper) => {
      if (!Array.isArray(messages)) {
        return
      }
      let rootRule: Rule | undefined
      for (const { type, originalName, originalValue } of messages) {
        const decl = helper.decl({
          prop: originalName,
          value: originalValue,
        })
        if (type === 'theme-vars') {
          root.append(decl)
          continue
        }
        if (type === 'theme-root-vars') {
          if (!rootRule) {
            rootRule = helper.rule({
              selector: ':root',
              nodes: [],
            })
            root.append(rootRule)
          }
          rootRule.append(decl)
        }
      }
    },
  }))
}

// 提取外部资源引用URL变量
export function extractURLVars(options: ExtractVarsPluginOptions) {
  return pluginFactory(options, ({ regExps }) => ({
    OnceExit: async (root, helper) => {
      const sourceFile = root.source?.input.file || helper.result.opts.from
      if (!sourceFile) {
        return
      }
      const vars = getTopScopeVariables(root, regExps)
      for (const { value, decl, ...rest } of vars.values()) {
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
            from: sourceFile,
            data: paths,
          })
        }
      }
    },
  }))
}
