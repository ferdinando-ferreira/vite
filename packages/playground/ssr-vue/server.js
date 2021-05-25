// @ts-check
const fs = require('fs')
const path = require('path')
const express = require('express')

const isTest = process.env.NODE_ENV === 'test' || !!process.env.VITE_TEST_BUILD

async function createServer(
  root = process.cwd(),
  isProd = process.env.NODE_ENV === 'production'
) {
  const resolve = (p) => path.resolve(__dirname, p)

  const indexProd = isProd
    ? fs.readFileSync(resolve('dist/client/index.html'), 'utf-8')
    : ''

  const prodManifest = isProd
    ? // @ts-ignore
      require('./dist/client/ssr-manifest.json')
    : {}

  const app = express()

  /**
   * @type {import('vite').ViteDevServer}
   */
  let vite
  if (!isProd) {
    vite = await require('vite').createServer({
      root,
      logLevel: isTest ? 'error' : 'info',
      server: {
        middlewareMode: 'ssr',
        watch: {
          // During tests we edit the files too fast and sometimes chokidar
          // misses change events, so enforce polling for consistency
          usePolling: true,
          interval: 100
        }
      }
    })
    // use vite's connect instance as middleware
    app.use(vite.middlewares)
  } else {
    app.use(require('compression')())
    app.use(
      require('serve-static')(resolve('dist/client'), {
        index: false
      })
    )
  }

  app.use('*', async (req, res) => {
    try {
      const url = req.originalUrl

      let template, render
      if (!isProd) {
        // always read fresh template in dev
        template = fs.readFileSync(resolve('index.html'), 'utf-8')
        template = await vite.transformIndexHtml(url, template)
        render = (await vite.ssrLoadModule('/src/entry-server.js')).render
      } else {
        template = indexProd
        render = require('./dist/server/entry-server.js').render
      }

      const [appHtml, modules] = await render(url)

      function renderPreloadLinks(modules, manifest, isProd, idToCode) {
        let links = ''
        const seen = new Set()
        modules.forEach((id) => {
          const files = manifest[id]
          if (files) {
            files.forEach((file) => {
              if (!seen.has(file)) {
                seen.add(file)
                links += isProd
                  ? renderPreloadLinkProd(file)
                  : renderPreloadLinkDev(file, idToCode)
              }
            })
          }
        })
        return links
      }

      function renderPreloadLinkProd(file) {
        if (file.endsWith('.js')) {
          return `<link rel="modulepreload" crossorigin href="${file}">`
        } else if (file.endsWith('.css')) {
          return `<link rel="stylesheet" href="${file}">`
        } else {
          // TODO
          return ''
        }
      }

      function renderPreloadLinkDev(file, idToCode) {
        if (file.endsWith('.css') && idToCode[file]) {
          return `<style>${idToCode[file]}</style>`
        } else {
          return ''
        }
      }

      let preloadLinks = ''
      let idToCode = {}
      let manifest
      if (isProd) {
        manifest = prodManifest
      } else {
        function requireFromString(src) {
          var Module = module.constructor
          var m = new Module()
          m._compile(src, '')
          return m.exports
        }
        const manifestIdToModule = {}
        vite.moduleGraph.idToModuleMap.forEach((module) => {
          manifestIdToModule[module.id] = module
          if (/.css$/.test(module.id)) {
            if (module.transformResult?.code) {
              const found = module.transformResult.code
                .split(/\r?\n/)
                .filter((line) => /^const css/.test(line))
              if (found) {
                idToCode[module.id] = requireFromString(
                  found[0] + '\nmodule.exports = css'
                )
              }
            }
          }
        })
        const devManifest = {}
        Array.from(modules).forEach((moduleId) => {
          devManifest[moduleId] = Array.from(
            manifestIdToModule[moduleId].importedModules
          ).map((module) => module.id)
        })
        manifest = devManifest
      }
      preloadLinks = renderPreloadLinks(modules, manifest, isProd, idToCode)

      const html = template
        .replace(`<!--preload-links-->`, preloadLinks)
        .replace(`<!--app-html-->`, appHtml)

      res.status(200).set({ 'Content-Type': 'text/html' }).end(html)
    } catch (e) {
      vite && vite.ssrFixStacktrace(e)
      console.log(e.stack)
      res.status(500).end(e.stack)
    }
  })

  return { app, vite }
}

if (!isTest) {
  createServer().then(({ app }) =>
    app.listen(3000, () => {
      console.log('http://localhost:3000')
    })
  )
}

// for test use
exports.createServer = createServer
