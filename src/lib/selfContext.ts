import * as fs from 'fs'
import * as path from 'path'

// 获取自身模块在运行时的上下文路径（根路径）
function getSelfContext() {
  const cwd = fs.realpathSync(process.cwd())
  const moduleName = '@ices/theme-webpack-plugin'
  let file = __filename
  if (file.startsWith(path.resolve('node_modules'))) {
    return path.dirname(require.resolve(`${moduleName}/package.json`, { paths: [cwd] }))
  }
  if ((file = getContextFromFile(file, cwd))) {
    return file
  }
  try {
    if (require(path.join(file, 'package.json')).name === moduleName) {
      return file
    }
  } catch (e) {}
  const error = new Error(`Can not resolve the runtime path of '${moduleName}' module`)
  Object.defineProperty(error, 'code', {
    value: 'MODULE_NOT_FOUND',
  })
  throw error
}

export function getContextFromFile(file: string, cwd = process.cwd()) {
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
