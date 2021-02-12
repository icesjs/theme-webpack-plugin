import * as fs from 'fs'
import * as path from 'path'

// 获取自身模块在运行时的上下文路径（根路径）
function getSelfContext() {
  const cwd = fs.realpathSync(process.cwd())
  const context = getContextFromFile(__filename, cwd)
  if (context) {
    return context
  }
  const error = new Error(`Can not resolve the runtime path from '${cwd}'`)
  Object.defineProperty(error, 'code', {
    value: 'MODULE_NOT_FOUND',
  })
  throw error
}

export function getContextFromFile(file: string, cwd = process.cwd()) {
  file = path.join(file, 'index.js')
  while (!fs.existsSync(path.join((file = path.dirname(file)), 'package.json'))) {
    if (file === cwd || path.basename(file) === 'node_modules') {
      file = ''
      break
    }
  }
  if (file && path.dirname(file) !== file) {
    return file
  }
  return ''
}

export const selfContext = getSelfContext()

export const packageJson: { [p: string]: any } = require(path.join(selfContext, 'package.json'))

export const selfModuleName: string = packageJson.name
