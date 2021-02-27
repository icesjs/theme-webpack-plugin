import * as path from 'path'
import valueParser from 'postcss-value-parser'
import { Container, Message, Node } from 'postcss'
import { hasResourceURL, isTopRootRule } from './assert'
import { getTopScopeVariables, toVarsDict } from './variables'
import {
  ExtendPluginOptions,
  ExtendType,
  getSourceFile,
  getVarsMessages,
  insertRawBefore,
  parseURLPaths,
  pluginFactory,
  PluginMessages,
  pluginName,
  PluginOptions,
  setVarsMessage,
} from './tools'
import {
  CustomPropsDictItem,
  determineCanUseAsThemeVarsByValue,
  getDeclProcessor,
  getThemeScopeProcessor,
} from './process'
import { addTitleComment, insertVarsRootRule } from './helpers'
import { ChildNode } from 'postcss/lib/node'

interface SpecialNodesMessage extends Message {
  plugin: typeof pluginName
  type: 'theme-special-nodes'
  data: Node[]
}

// 消息 theme-vars 、 theme-root-vars
export function defineThemeVariablesPlugin(options: PluginOptions) {
  return pluginFactory(options, ({ regExps, onlyColor }) => ({
    OnceExit: async (root, helper) => {
      const variables = getTopScopeVariables(root, regExps)
      for (const { value, isRootDecl, ...rest } of variables.values()) {
        if (determineCanUseAsThemeVarsByValue(value, onlyColor)) {
          const type = isRootDecl ? 'theme-root-vars' : 'theme-vars'
          setVarsMessage({ ...rest, value, isRootDecl, helper, type })
        }
      }
    },
  }))
}

// 消息 theme-context
export function defineContextVarsPlugin(options: PluginOptions) {
  return pluginFactory(options, ({ regExps }) => ({
    Once: async (root, helper) => {
      // 这里不对值进行引用解析，是因为此时并不知道上下文中所有可用的变量
      for (const vars of getTopScopeVariables(root, regExps, null, false).values()) {
        setVarsMessage({ ...vars, helper, type: 'theme-context-vars' })
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
        const { value, from, ...rest } = vars
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

// 使用主题变量替换变量引用，修改原样式文件
export function replaceWithThemeVarsPlugin(
  options: ExtendPluginOptions<ExtendType<Required<PluginMessages>, { isThemeFile: boolean }>>
) {
  return pluginFactory(options, ({ isThemeFile, ...pluginContext }) => ({
    OnceExit: async (root, helper) => {
      const { vars } = pluginContext
      // 不能作为主题变量使用的自定义属性
      const customProps = toVarsDict<CustomPropsDictItem>(
        !isThemeFile ? getVarsMessages(helper.result.messages, 'theme-custom-prop') : []
      )
      // 处理属性值
      root.walkDecls(getDeclProcessor({ ...pluginContext, vars: { ...vars, customProps }, helper }))

      // 清理从主题文件中导入的没有使用的自定义属性
      if (customProps.size) {
        for (const { used, rawNode } of customProps.values()) {
          if (used) {
            continue
          }
          // 这里要先取parent，再删
          const { parent } = rawNode
          rawNode.remove()
          if (parent && isTopRootRule(parent) && !parent.nodes.length) {
            parent.remove()
          }
        }
      }

      // 需要写入的:root规则属性
      const properties = !isThemeFile
        ? toVarsDict(getVarsMessages(helper.result.messages, 'theme-prop-vars'))
        : pluginContext.vars.variables

      // 写入:root规则声明到文件
      const node = insertVarsRootRule({
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

// 合并主题文件中的变量到当前解析文件
// 消息：theme-custom-prop
export function mergeThemeFileVarsPlugin(
  options: ExtendPluginOptions<{ isThemeFile: (filename: string) => boolean }>
) {
  return pluginFactory(options, ({ regExps, onlyColor, isThemeFile }) => ({
    OnceExit: async (root, helper) => {
      if (isThemeFile(getSourceFile(helper, root))) {
        const variables = [...getTopScopeVariables(root, regExps, null, true, true).values()]
        const clearNode = (node: ChildNode) => {
          if (node.type === 'comment') {
            return
          }
          const vars = variables.find((vars) => vars.rawNode === node)
          if (!vars) {
            node.remove()
          } else if (vars.isRootDecl) {
            // :root decl
            if (determineCanUseAsThemeVarsByValue(vars.value, onlyColor)) {
              // 主题变量由主题文件引入，不导入当前文件
              node.remove()
            } else {
              // css自定义变量不像scss变量处理完成后会被清理，这里记录并手动清理
              setVarsMessage({ ...vars, type: 'theme-custom-prop', helper })
            }
          }
        }
        //
        root.each((node) => {
          if (isTopRootRule(node)) {
            node.each((child) => clearNode(child))
            if (!node.nodes.filter((node) => node.type !== 'comment').length) {
              // 清理空的节点
              node.remove()
            }
          } else {
            clearNode(node)
          }
        })
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

// 保留导入节点的格式
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

// 为主题变量添加命名空间
// 消息：theme-special-rule-root
export function addThemeScopePlugin(
  options: ExtendPluginOptions<{ scope: string; themeAttrName: string }>
) {
  return pluginFactory(options, ({ scope, themeAttrName, syntax }) => ({
    Once: async (root, helper) => {
      const specialNodes: Node[] = []
      const processor = getThemeScopeProcessor(syntax, scope, themeAttrName)
      processor(root, (node: ChildNode) => {
        // @font-face、@page、@keyframes
        let rule
        if (node.parent !== root) {
          let parent
          let child: ChildNode | Container = node
          while ((parent = child.parent) && parent !== root) {
            const curr = child as ChildNode
            const great = parent.parent
            child = parent.clone({ nodes: [] })
            child.nodes = [curr]
            if (great !== root) {
              child.parent = great
            }
          }
          rule = child
        } else {
          rule = node
        }
        node.remove()
        specialNodes.push(rule)
      })
      //
      helper.result.messages.push({
        plugin: pluginName,
        type: 'theme-special-nodes',
        data: specialNodes,
      } as SpecialNodesMessage)
    },
  }))
}

// 抽取特殊的规则节点
// 前置插件：addThemeScopePlugin
// 前置消息：theme-special-nodes
export function extractSpecialRulePlugin(options: PluginOptions) {
  return pluginFactory(options, ({ regExps }) => ({
    OnceExit: async (root, helper) => {
      const isSpecialNodesMessage = (msg: Message): msg is SpecialNodesMessage => {
        const { plugin, type } = msg as SpecialNodesMessage
        return plugin === pluginName && type === 'theme-special-nodes'
      }
      const specialNodesMessage = helper.result.messages.find(isSpecialNodesMessage)
      if (specialNodesMessage) {
        const specialNodes = specialNodesMessage.data
        const variables = getTopScopeVariables(
          root,
          regExps,
          (decl, isRootDecl) => !isRootDecl,
          false,
          true
        ).values()
        const varNodes = []
        for (const { rawNode } of variables) {
          varNodes.push(rawNode)
        }
        root.removeAll().append(varNodes).append(specialNodes)
      }
    },
  }))
}
