import * as types from '@babel/types'
import {
  ArrowFunctionExpression,
  CallExpression,
  Function as BabelFunction,
  FunctionExpression,
  Statement,
} from '@babel/types'
import { NodePath, PluginObj } from '@babel/core'

// 获取匿名函数的引用变量
function getFunctionExpressionReferences(
  path: NodePath<Statement>,
  init: ArrowFunctionExpression | FunctionExpression
) {
  const { node } = path
  const names: string[] = []
  if (types.isVariableDeclaration(node)) {
    const { declarations } = node
    for (const { id } of declarations.filter((decl) => decl.init === init)) {
      if (types.isIdentifier(id)) {
        names.push(id.name)
      }
    }
  }
  return new Set<string>(names)
}

// 获取函数声明的引用变量名称
function getFunctionDeclarationReferences(path: NodePath<BabelFunction>) {
  const { node: func } = path
  const names: string[] = []
  if (types.isFunctionExpression(func) || types.isArrowFunctionExpression(func)) {
    const stmt = path.getStatementParent()
    if (stmt) {
      names.push(...getFunctionExpressionReferences(stmt, func))
    }
  } else if (types.isFunctionDeclaration(func)) {
    const { id } = func
    if (types.isIdentifier(id)) {
      names.push(id.name)
    }
  }
  return new Set<string>(names)
}

// 转换为 await 调用的表达式
function toAwaitCallExpression(path: NodePath<CallExpression>) {
  if (!types.isCallExpression(path) || types.isAwaitExpression(path.parent)) {
    return
  }
  const stmt = path.getStatementParent()
  if (types.isExpressionStatement(stmt?.node)) {
    const { expression } = stmt!.node
    if (types.isAwaitExpression(expression)) {
      return
    }
  }
  const parent = path.getFunctionParent()!
  const { node: func } = parent
  if (!func.async) {
    toAsyncFunction(parent)
  }
  path.replaceWith(types.awaitExpression(path.node))
}

// 转换异步函数
function toAsyncFunction(path: NodePath<BabelFunction>) {
  const { node: func, context } = path
  func.async = true
  for (const name of getFunctionDeclarationReferences(path)) {
    const binding = context.scope.getBinding(name)
    if (binding?.referenced) {
      continue
    }
    for (const refPath of binding!.referencePaths) {
      const parentPath = refPath.parentPath
      if (types.isCallExpression(parentPath)) {
        toAwaitCallExpression(parentPath as NodePath<CallExpression>)
      }
    }
  }
}

// babel插件
// 将全局方法，转换为异步调用形式
// 这里仅限全局方法，而且暂时也只需要处理全局方法
export default function (globalMethods: string[]) {
  return {
    visitor: {
      CallExpression(path) {
        const { callee } = path.node
        for (const name of globalMethods) {
          if (types.isIdentifier(callee, { name })) {
            toAwaitCallExpression(path)
          }
        }
      },
    },
  } as PluginObj
}
