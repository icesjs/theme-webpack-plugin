// import childCompiler from '../lib/childCompiler'
import { PluginLoader } from '../Plugin'

const extractLoader: PluginLoader = function (source, map) {
  // new childCompiler(this._compilation).compile()
  this.callback(null, source, map)
}

extractLoader.filepath = __filename
export default extractLoader
