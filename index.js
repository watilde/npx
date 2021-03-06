#!/usr/bin/env node
'use strict'

const Buffer = require('safe-buffer').Buffer

const child = require('./child')
const fs = require('fs')
const parseArgs = require('./parse-args.js')
const path = require('path')
const which = promisify(require('which'))

const PATH_SEP = process.platform === 'win32' ? ';' : ':'

main(parseArgs())

module.exports = main
function main (argv) {
  const shell = argv['shell-auto-fallback']
  if (shell || shell === '') {
    const fallback = require('./auto-fallback.js')(
      shell, process.env.SHELL, argv
    )
    if (fallback) {
      return console.log(fallback)
    } else {
      process.exitCode = 1
      return
    }
  }

  if (!argv.call && (!argv.command || !argv.package)) {
    !argv.q && console.error(Y()`\nERROR: You must supply a command.\n`)
    !argv.q && parseArgs.showHelp()
    process.exitCode = 1
    return
  }

  const startTime = Date.now()

  // First, we look to see if we're inside an npm project, and grab its
  // bin path. This is exactly the same as running `$ npm bin`.
  return localBinPath(process.cwd()).then(local => {
    if (local) {
      // Local project paths take priority. Go ahead and prepend it.
      process.env.PATH = `${local}${PATH_SEP}${process.env.PATH}`
    }
    return Promise.all([
      // Figuring out if a command exists, early on, lets us maybe
      // short-circuit a few things later. This bit here primarily benefits
      // calls like `$ npx foo`, where we might just be trying to invoke
      // a single command and use whatever is already in the path.
      argv.command && getExistingPath(argv.command, argv),
      // The `-c` flag involves special behavior when used: in this case,
      // we take a bit of extra time to pick up npm's full lifecycle script
      // environment (so you can use `$npm_package_xxxxx` and company).
      // Without that flag, we just use the current env.
      argv.call && getEnv(argv)
    ]).then(args => {
      const existing = args[0]
      const newEnv = args[1]
      if (newEnv) {
        // NOTE - we don't need to manipulate PATH further here, because
        //        npm has already done so. And even added the node-gyp path!
        process.env = newEnv
      }
      if ((!existing && !argv.call) || argv.packageRequested) {
        // We only fire off the updateNotifier if we're installing things
        require('update-notifier')({pkg: require('./package.json')}).notify()
        // Some npm packages need to be installed. Let's install them!
        return ensurePackages(argv.package, argv).then(results => {
          results && !argv.q && console.error(Y()`npx: installed ${
            results.added.length + results.updated.length
          } in ${(Date.now() - startTime) / 1000}s`)
        }).then(() => existing)
      } else {
        // We can skip any extra installation, 'cause everything exists.
        return existing
      }
    }).then(existing => {
      return execCommand(existing, argv)
    }).catch(err => {
      !argv.q && console.error(err.message)
      process.exitCode = err.exitCode || 1
    })
  })
}

module.exports._localBinPath = localBinPath
function localBinPath (cwd) {
  return require('./get-prefix.js')(cwd).then(prefix => {
    return path.join(prefix, 'node_modules', '.bin')
  })
}

module.exports._getEnv = getEnv
function getEnv (opts) {
  return child.exec(opts.npm, ['run', 'env']).then(require('dotenv').parse)
}

function ensurePackages (specs, opts) {
  return (
    opts.cache ? Promise.resolve(opts.cache) : getNpmCache(opts)
  ).then(cache => {
    const prefix = path.join(cache, '_npx')
    const bins = process.platform === 'win32'
    ? prefix
    : path.join(prefix, 'bin')
    return promisify(require('rimraf'))(bins).then(() => {
      return installPackages(specs, prefix, opts)
    }).then(info => {
      // This will make temp bins _higher priority_ than even local bins.
      // This is intentional, since npx assumes that if you went through
      // the trouble of doing `-p`, you're rather have that one. Right? ;)
      process.env.PATH = `${bins}${PATH_SEP}${process.env.PATH}`
      return info
    })
  })
}

module.exports._getExistingPath = getExistingPath
function getExistingPath (command, opts) {
  if (opts.cmdHadVersion || opts.packageRequested || opts.ignoreExisting) {
    return Promise.resolve(false)
  } else {
    return which(command).catch(err => {
      if (err.code === 'ENOENT') {
        if (!opts.install) {
          err.exitCode = 127
          throw err
        }
      } else {
        throw err
      }
    })
  }
}

module.exports._getNpmCache = getNpmCache
function getNpmCache (opts) {
  return which(opts.npm).then(npmPath => {
    const args = ['config', 'get', 'cache']
    if (opts.userconfig) {
      args.push('--userconfig', child.escapeArg(opts.userconfig, true))
    }
    return child.exec(npmPath, args)
  }).then(cache => cache.trim())
}

module.exports._buildArgs = buildArgs
function buildArgs (specs, prefix, opts) {
  const args = ['install'].concat(specs)
  args.push('--global', '--prefix', prefix)
  if (opts.cache) args.push('--cache', opts.cache)
  if (opts.userconfig) args.push('--userconfig', opts.userconfig)
  args.push('--loglevel', 'error', '--json')

  return args
}

module.exports._installPackages = installPackages
function installPackages (specs, prefix, opts) {
  const args = buildArgs(specs, prefix, opts)
  return which(opts.npm).then(npmPath => {
    return child.spawn(npmPath, args, {
      stdio: [0, 'pipe', opts.q ? 'ignore' : 2]
    }).then(deets => {
      try {
        return deets.stdout ? JSON.parse(deets.stdout) : null
      } catch (e) { }
    }, err => {
      if (err.exitCode) {
        err.message = Y()`Install for ${specs} failed with code ${err.exitCode}`
      }
      throw err
    })
  })
}

function execCommand (existing, argv) {
  return checkIfNode(existing).then(isNode => {
    const Module = require('module')
    if (isNode && Module.runMain && !argv.shell) {
      // let it take over the process. This means we can skip node startup!
      if (!argv.noYargs) {
        // blow away built-up yargs crud
        require('yargs').reset()
      }
      process.argv = [
        process.argv[0], // Current node binary
        existing // node script path. `runMain()` will set this as the new main
      ].concat(argv.cmdOpts) // options for the cmd itself
      Module.runMain() // ✨MAGIC✨. Sorry-not-sorry
    } else {
      return child.runCommand(existing, argv).catch(err => {
        if (err.isOperational && err.exitCode) {
          // At this point, we want to treat errors from the child as if
          // we were just running the command. That means no extra msg logging
          process.exitCode = err.exitCode
        } else {
          // But if it's not just a regular child-level error, blow up normally
          throw err
        }
      })
    }
  })
}

function checkIfNode (existing) {
  if (!existing || process.platform === 'win32') {
    return Promise.resolve(false)
  } else {
    // NOTE: only *nix is supported for process-replacement juggling
    const line = '#!/usr/bin/env node\n'
    const bytecount = line.length
    const buf = Buffer.alloc(bytecount)
    return promisify(fs.open)(existing, 'r').then(fd => {
      return promisify(fs.read)(fd, buf, 0, bytecount, 0).then(() => {
        return promisify(fs.close)(fd)
      }, err => {
        return promisify(fs.close)(fd).then(() => { throw err })
      })
    }).then(() => {
      return buf.toString('utf8') === line
    })
  }
}

function Y () {
  return require('./y.js')
}

function promisify (f) {
  const util = require('util')
  if (util.promisify) {
    return util.promisify(f)
  } else {
    return function () {
      return new Promise((resolve, reject) => {
        f.apply(this, [].slice.call(arguments).concat((err, val) => {
          err ? reject(err) : resolve(val)
        }))
      })
    }
  }
}
