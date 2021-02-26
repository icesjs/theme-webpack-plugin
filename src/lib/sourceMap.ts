import * as path from 'path'

const IS_NATIVE_WIN32_PATH = /^[a-z]:[/\\]|^\\\\/i
const ABSOLUTE_SCHEME = /^[a-z0-9+\-.]+:/i

function getURLType(source: string) {
  if (source[0] === '/') {
    if (source[1] === '/') {
      return 'scheme-relative'
    }
    return 'path-absolute'
  }
  if (IS_NATIVE_WIN32_PATH.test(source)) {
    return 'path-absolute'
  }
  return ABSOLUTE_SCHEME.test(source) ? 'absolute' : 'path-relative'
}

export function normalizeSourceMap(map: any, resourceContext: string) {
  const newMap = typeof map === 'string' ? JSON.parse(map) : map
  const { sourceRoot } = newMap

  delete newMap.file
  delete newMap.sourceRoot

  if (newMap.sources) {
    newMap.sources = newMap.sources.map((source: string) => {
      const sourceType = getURLType(source)
      if (sourceType === 'path-relative' || sourceType === 'path-absolute') {
        const absoluteSource =
          sourceType === 'path-relative' && sourceRoot
            ? path.resolve(sourceRoot, path.normalize(source))
            : path.normalize(source)
        return path.relative(resourceContext, absoluteSource)
      }
      return source
    })
  }

  return newMap
}

export function normalizeSourceMapAfterPostcss(map: any, resourceContext: string) {
  const newMap = map
  delete newMap.file
  newMap.sourceRoot = ''
  newMap.sources = newMap.sources.map((source: string) => {
    if (source.indexOf('<') === 0) {
      // <no-source>
      return source
    }
    const sourceType = getURLType(source)
    if (sourceType === 'path-relative') {
      return path.resolve(resourceContext, source)
    }
    return source
  })
  return newMap
}
