import { createServer, Server } from 'http'
import path from 'path'
import { parse } from 'url'
import { getRouteFromApp, getURLParams } from './request'
import type { Request } from './request'
import type { Response } from './response'
import type { ErrorHandler } from './onError'
import { onErrorHandler } from './onError'
import { Middleware, Handler, NextFunction, Router } from '@tinyhttp/router'
import { extendMiddleware } from './extend'
import { matchLoose, matchParams, runRegex } from '@tinyhttp/req'

/**
 * Add leading slash if not present (e.g. path -> /path, /path -> /path)
 * @param x
 */
const lead = (x: string) => (x.charCodeAt(0) === 47 ? x : '/' + x)

export const applyHandler = <Req, Res>(h: Handler<Req, Res>) => async (req: Req, res: Res, next?: NextFunction) => {
  if (h[Symbol.toStringTag] === 'AsyncFunction') {
    try {
      await h(req, res, next)
    } catch (e) {
      next(e)
    }
  } else h(req, res, next)
}
/**
 * tinyhttp App has a few settings for toggling features
 */
export type AppSettings = Partial<{
  networkExtensions: boolean
  freshnessTesting: boolean
  subdomainOffset: number
  bindAppToReqRes: boolean
  xPoweredBy: boolean
}>

/**
 * Function that processes the template
 */
export type TemplateFunc<O> = (
  path: string,
  locals: Record<string, any>,
  opts: TemplateEngineOptions<O>,
  cb: (err: Error, html: unknown) => void
) => void

export type TemplateEngineOptions<O = any> = Partial<{
  cache: boolean
  ext: string
  renderOptions: Partial<O>
  viewsFolder: string
  _locals: Record<string, any>
}>

/**
 * `App` class - the starting point of tinyhttp app.
 *
 * With the `App` you can:
 * * use routing methods and `.use(...)`
 * * set no match (404) and error (500) handlers
 * * configure template engines
 * * store data in locals
 * * listen the http server on a specified port
 *
 * In case you use TypeScript, you can pass custom types to this class because it is also a generic class.
 *
 * Example:
 *
 * ```ts
 * interface CoolReq extends Request {
 *  genericsAreDope: boolean
 * }
 *
 * const app = App<any, CoolReq, Response>()
 * ```
 */
export class App<
  RenderOptions = any,
  Req extends Request = Request,
  Res extends Response<RenderOptions> = Response<RenderOptions>
> extends Router<App, Req, Res> {
  middleware: Middleware<Req, Res>[] = []
  locals: Record<string, string> = {}
  noMatchHandler: Handler
  onError: ErrorHandler
  settings: AppSettings
  engines: Record<string, TemplateFunc<RenderOptions>> = {}
  applyExtensions: (req: Request, res: Response, next: NextFunction) => void

  constructor(
    options: Partial<{
      noMatchHandler: Handler<Req, Res>
      onError: ErrorHandler
      settings: AppSettings
      applyExtensions: (req: Request, res: Response, next: NextFunction) => void
    }> = {}
  ) {
    super()
    this.onError = options?.onError || onErrorHandler
    this.noMatchHandler = options?.noMatchHandler || this.onError.bind(null, { code: 404 })
    this.settings = options.settings || { xPoweredBy: true }
    this.applyExtensions = options?.applyExtensions
  }
  /**
   * Set app setting
   * @param setting setting name
   * @param value setting value
   */
  set(setting: string, value: any) {
    this.settings[setting] = value

    return this
  }

  /**
   * Enable app setting
   * @param setting Setting name
   */
  enable(setting: string) {
    this.settings[setting] = true

    return this
  }

  /**
   * Disable app setting
   * @param setting
   */
  disable(setting: string) {
    this.settings[setting] = false

    return this
  }

  /**
   * Render a template
   * @param file What to render
   * @param data data that is passed to a template
   * @param options Template engine options
   * @param cb Callback that consumes error and html
   */
  render(
    file: string,
    data: Record<string, any> = {},
    cb: (err: unknown, html: unknown) => void,
    options: TemplateEngineOptions<RenderOptions> = {}
  ) {
    options.viewsFolder = options.viewsFolder || `${process.cwd()}/views`
    options.ext = options.ext || file.slice(file.lastIndexOf('.') + 1) || 'ejs'

    options._locals = options._locals || {}

    options.cache = options.cache || process.env.NODE_ENV === 'production'

    let locals = { ...data, ...this.locals }

    if (options._locals) locals = { ...locals, ...options._locals }

    if (!file.endsWith(`.${options.ext}`)) file = `${file}.${options.ext}`

    const dest = options.viewsFolder ? path.join(options.viewsFolder, file) : file

    this.engines[options.ext](dest, locals, options.renderOptions, cb)

    return this
  }
  /**
   * Register a template engine with extension
   */
  engine(ext: string, fn: TemplateFunc<RenderOptions>) {
    this.engines[ext] = fn

    return this
  }

  /**
   * Extends Req / Res objects, pushes 404 and 500 handlers, dispatches middleware
   * @param req Req object
   * @param res Res object
   */
  async handler(req: Req, res: Res) {
    /* Set X-Powered-By header */
    if (this.settings?.xPoweredBy === true) res.setHeader('X-Powered-By', 'tinyhttp')

    const mw = this.middleware

    const subappPath = Object.keys(this.apps).find((x) => req.url.startsWith(x))

    if (subappPath) {
      this.apps[subappPath].handler(req, res)
      return
    }

    const noMatchMW: Middleware = {
      handler: this.noMatchHandler,
      type: 'mw',
      path: '/'
    }

    mw.push(noMatchMW)

    let idx = 0
    const len = mw.length - 1

    const nextWithReqAndRes = (req: Req, res: Res) => (err: any) => {
      if (err && !res.writableEnded) this.onError(err, req, res)
      else loop(req, res)
    }

    const handle = (mw: Middleware) => async (req: Req, res: Res, next?: NextFunction) => {
      const { path, method, handler, type } = mw

      req.originalUrl = req.url

      req.url = lead(req.url.substring(path.length)) || '/'

      const { pathname } = parse(req.originalUrl)

      req.path = parse(req.url).pathname

      this.applyExtensions
        ? this.applyExtensions(req, res, next)
        : extendMiddleware<RenderOptions>(this)(req, res, next)

      if (type === 'route' && req.method === method) {
        const regex = runRegex(path)

        if (matchParams(regex, pathname)) {
          req.params = getURLParams(regex, pathname)
          req.route = getRouteFromApp(this, (handler as unknown) as Handler<Req, Res>)
          res.statusCode = 200

          await applyHandler<Req, Res>((handler as unknown) as Handler<Req, Res>)(req, res, next)
        } else {
          req.url = req.originalUrl
          loop(req, res)
        }
      } else if (type === 'mw' && matchLoose(path, pathname)) {
        await applyHandler<Req, Res>((handler as unknown) as Handler<Req, Res>)(req, res, next)
      } else {
        req.url = req.originalUrl
        loop(req, res)
      }
    }

    const loop = (req: Req, res: Res) => {
      if (res.writableEnded) return
      else if (idx <= len) handle(mw[idx++])(req, res, nextWithReqAndRes(req, res))
      else return
    }

    loop(req, res)
  }

  /**
   * Creates HTTP server and dispatches middleware
   * @param port server listening port
   * @param Server callback after server starts listening
   * @param host server listening host
   */
  listen(port?: number, cb?: () => void, host = '0.0.0.0'): Server {
    const server = createServer()

    server.on('request', (req, res) => this.handler(req, res))

    return server.listen(port, host, cb)
  }
}
