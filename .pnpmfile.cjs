const fs = require('fs')
const path = require('path')

const LOCAL_OVERRIDES = {
  playsvideo: path.resolve(__dirname, '..', 'playsvideo'),
}

function readPackage(pkg, context) {
  for (const [name, localPath] of Object.entries(LOCAL_OVERRIDES)) {
    if (pkg.dependencies?.[name] && fs.existsSync(localPath)) {
      pkg.dependencies[name] = `link:${localPath}`
      context.log(`${name} → local link: ${localPath}`)
    }
  }
  return pkg
}

module.exports = { hooks: { readPackage } }
