import express from 'express';
import { Request, Response } from 'express-serve-static-core';
import fs from 'fs';
import marked from 'marked';
import nunjucks from 'nunjucks';
import { Script, Sketch } from 'p5-analysis';
import path from 'path';
import { createDirectoryListing } from './directory-listing';
import { templateDir } from './globals';
import { createLiveReloadServer, injectLiveReloadScript } from './liveReload';
import WebSocket = require('ws');
import http = require('http');
import { closeSync, listenSync } from './http-server-sync';
import { EventEmitter } from 'stream';
import { URL } from 'url';

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Server {
  export type MountPointOption = string | { filePath: string; name?: string; urlPath?: string };

  export type Options = Partial<{
    /** The http port number. Defaults to 3000. */
    port: number;
    /** If true, then if the specified port number is not available, find another port. Defaults to true. */
    scanPorts: boolean;
    /** If true, relay console events from the sketch to an emitter on the server. */
    relayConsoleMessages: boolean;
    /** The base directory. Defaults to the current working directory. */
    root: string | null;
    /** A list of base directories. If this is present, it overrides the root option. */
    mountPoints: MountPointOption[];
  }>;
}

type ServerConfig = Required<Server.Options>;

type RouterConfig = Server.Options & {
  root: string;
  sketchFile?: string;
};

type MountPoint = { filePath: string; urlPath: string; name?: string };

const defaultServerOptions = {
  port: 3000,
  relayConsoleMessages: false,
  logConsoleEvents: false,
  scanPorts: true
};

const jsTemplateEnv = new nunjucks.Environment(null, { autoescape: false });
jsTemplateEnv.addFilter('quote', JSON.stringify);

function createRouter(config: RouterConfig): express.Router {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const file = config.sketchFile;
    if (file) {
      if (await Sketch.isSketchScriptFile(file)) {
        const sketch = await Sketch.fromFile(file);
        sendHtml(req, res, await sketch.getHtmlContent());
      } else {
        res.sendFile(file);
      }
    } else {
      await sendDirectoryListing(config.root, req, res);
    }
  });

  router.get('/*.html?', (req, res, next) => {
    const file = path.join(config.root, req.path);
    try {
      if (req.query.fmt === 'view') {
        res.set('Content-Type', 'text/plain');
        res.sendFile(req.path, { root: config.root });
        return;
      }
      if (req.headers['accept']?.match(/\btext\/html\b/)) {
        sendHtml(req, res, fs.readFileSync(file, 'utf-8'));
        return;
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw e;
      }
    }
    next();
  });

  // A request for the HTML of a JavaScript file returns HTML that includes the sketch.
  // A request for the HTML of a main sketch js file redirects to the sketch's index page.
  router.get('/*.js', async (req, res, next) => {
    const file = path.join(config.root, req.path);
    if (
      req.headers['accept']?.match(/\btext\/html\b/) &&
      req.query.fmt !== 'view' &&
      (await Sketch.isSketchScriptFile(file))
    ) {
      const { sketches } = await Sketch.analyzeDirectory(path.dirname(file));
      const sketch = sketches.find(sketch => sketch.files.includes(path.basename(file)));
      if (sketch) {
        sendHtml(req, res, await sketch.getHtmlContent());
        return;
      }
    }
    try {
      const errs = Script.fromFile(file).getErrors();
      if (errs.length) {
        const template = fs.readFileSync(path.join(templateDir, 'report-syntax-error.js.njk'), 'utf8');
        return res.send(
          jsTemplateEnv.renderString(template, {
            fileName: path.basename(file), // TODO: relative to referer
            message: errs[0].message
          })
        );
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw e;
      }
    }
    next();
  });

  router.get('/*.md', (req, res, next) => {
    if (req.headers['accept']?.match(/\btext\/html\b/)) {
      const file = path.join(config.root, req.path);
      if (!fs.existsSync(file)) {
        return next();
      }
      const fileData = fs.readFileSync(file, 'utf-8');
      res.send(marked(fileData));
    }
    return next();
  });

  router.get('*', async (req, res, next) => {
    if (req.headers['accept']?.match(/\btext\/html\b/)) {
      const file = path.join(config.root, req.path);
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
        await sendDirectoryListing(config.root, req, res);
        return;
      }
    }
    next();
  });

  return router;

  function sendHtml<T>(req: Request<unknown, unknown, unknown, unknown, T>, res: Response<string, T>, html: string) {
    html = injectLiveReloadScript(html, req.app.locals.liveReloadServer);
    if (config.relayConsoleMessages) {
      html = html.replace(/(?=<\/head>)/, '<script src="/__p5_server_static/console-relay.js"></script>');
    }
    res.send(html);
  }
}

async function sendDirectoryListing<T>(
  root: string,
  req: Request<unknown, unknown, unknown, unknown, T>,
  res: Response<string, T>
) {
  const reqPath = req.path;
  let fileData: string;
  const absPath = path.join(root, reqPath);
  // read the directory contents
  const indexFile = fs.readdirSync(absPath).find(file => /^index\.html?$/i.test(file));
  if (indexFile) {
    // This is needed for linked files to work.
    if (!reqPath.endsWith('/')) {
      res.redirect(reqPath + '/');
      return;
    }
    fileData = fs.readFileSync(path.join(absPath, indexFile), 'utf-8');
  } else {
    fileData = await createDirectoryListing(absPath, reqPath);
  }

  // Note: This injects the reload script into the generated index pages too.
  // This assures that the index page reloads when the directory contents
  // change.
  res.send(injectLiveReloadScript(fileData, req.app.locals.liveReloadServer));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SketchConsoleEvent = {
  method: 'log' | 'warn' | 'error' | 'info' | 'debug';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[];
  url: string;
  file?: string;
};
type SketchErrorEvent = ErrorMessageEvent & { url: string; file?: string };

type ErrorMessageEvent = (
  | { kind: 'error'; line: number; col: number; url: string }
  | { kind: 'unhandledRejection' }
) & {
  message: string;
  stack: string;
};

interface SketchRelay {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emitSketchEvent(eventName: string | symbol, ...args: any[]): boolean;
  filePathToUrl(filePath: string): string | null;
  urlPathToFilePath(urlPath: string): string | null;
}

function consoleRelayRouter(relay: SketchRelay): express.Router {
  const router = express.Router();

  router.post('/__p5_server_console', express.json(), (req, res) => {
    const { method, args } = req.body;
    const url = req.headers['referer']!;
    const data: SketchConsoleEvent = { method, args, url, file: urlToFilePath(url) };
    relay.emitSketchEvent('console', data);
    res.sendStatus(200);
  });

  router.post('/__p5_server_error', express.json(), (req, res) => {
    const body = req.body as ErrorMessageEvent;
    const { url } = { url: req.headers['referer'], ...body };
    const data: SketchErrorEvent = {
      url,
      file: urlToFilePath(url),
      ...req.body,
      stack: replaceUrlsInStack(req.body.stack)
    };
    relay.emitSketchEvent('error', data);
    res.sendStatus(200);
  });

  return router;

  function urlToFilePath(url: string | undefined): string | undefined {
    return (url && relay.urlPathToFilePath(new URL(url).pathname)) || undefined;
  }

  function replaceUrlsInStack(stack: string | undefined): string | undefined {
    return stack
      ? stack.replace(/\bhttps?:\/\/localhost(?::\d+)?(\/[^\s:]+)/g, (s, p) => relay.urlPathToFilePath(p) || s)
      : stack;
  }
}

async function startServer(config: ServerConfig, sketchRelay: SketchRelay) {
  const mountPoints = config.mountPoints as MountPoint[];
  const app = express();
  app.use('/__p5_server_static', express.static(path.join(__dirname, 'static')));
  app.use(consoleRelayRouter(sketchRelay));
  for (const { filePath, urlPath } of mountPoints) {
    let root = filePath;
    let sketchFile: string | undefined;
    if (!fs.statSync(root).isDirectory()) {
      sketchFile = root;
      root = path.dirname(root);
    }
    const routerConfig: RouterConfig = { ...config, root, sketchFile };
    app.use(urlPath, createRouter(routerConfig));
    app.use('/', express.static(root));
  }

  // For effect only. This provide errors and diagnostics before waiting for a
  // browser request.
  if (fs.statSync(mountPoints[0].filePath).isDirectory()) {
    createDirectoryListing(mountPoints[0].filePath, mountPoints[0].urlPath);
  }

  let server: http.Server | null = null;
  const port = config.port;
  for (let p = port; p < port + 10; p++) {
    try {
      server = await listenSync(app, p);
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' || !config.scanPorts) {
        throw e;
      }
      console.log(`Port ${p} is in use, retrying...`);
    }
  }
  if (!server) {
    server = await listenSync(app);
  }

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start the server');
  }
  try {
    const liveReloadServer = createLiveReloadServer(mountPoints.map(mount => mount.filePath));
    app.locals.liveReloadServer = liveReloadServer;
    const url = `http://localhost:${address.port}`;
    return { server, liveReloadServer, url };
  } catch (e) {
    server.close();
    throw e;
  }
}

/** Server is a web server with live reload, sketch-aware directory listings,
 * and library inference for JavaScript-only sketches.
 */
export class Server implements SketchRelay {
  public server: http.Server | null = null;
  public url?: string;
  public mountPoints: MountPoint[];
  private readonly options: ServerConfig;
  private liveReloadServer: WebSocket.Server | null = null;
  private readonly sketchEmitter = new EventEmitter();
  public readonly emitSketchEvent = this.sketchEmitter.emit.bind(this.sketchEmitter);
  public readonly onSketchEvent = this.sketchEmitter.on.bind(this.sketchEmitter);

  constructor(options: Partial<Server.Options> = {}) {
    const mountPoints =
      options.mountPoints && options.mountPoints.length > 0
        ? Server.normalizeMountPoints(options.mountPoints)
        : [{ filePath: options.root || '.', urlPath: '/' }];
    this.mountPoints = mountPoints;
    this.options = { ...defaultServerOptions, root: null, ...options, mountPoints };
  }

  /** Create and start the server. Returns the instance. */
  public static async start(options: Partial<Server.Options> = {}) {
    return new Server(options).start();
  }

  public async start() {
    const { server, liveReloadServer, url } = await startServer(this.options, this);
    this.server = server;
    this.liveReloadServer = liveReloadServer;
    this.url = url;
    return this;
  }

  public async stop() {
    if (this.server) {
      await closeSync(this.server);
    }
    this.server = null;
    this.liveReloadServer?.close();
    this.liveReloadServer = null;
    this.url = undefined;
  }

  public filePathToUrl(filePath: string) {
    const baseUrl = this.url || `http://localhost:${this.options.port}`;
    for (const mountPoint of this.mountPoints) {
      const filePrefix = mountPoint.filePath + path.sep;
      const pathPrefix = (mountPoint.urlPath + '/').replace(/^\/\/$/, '/');
      if (filePath.startsWith(filePrefix)) {
        return baseUrl + filePath.replace(filePrefix, pathPrefix);
      }
    }
    return null;
  }

  public urlPathToFilePath(urlPath: string) {
    for (const mountPoint of this.mountPoints) {
      const filePrefix = mountPoint.filePath + path.sep;
      const pathPrefix = (mountPoint.urlPath + '/').replace(/^\/\/$/, '/');
      if (urlPath.startsWith(pathPrefix)) {
        return urlPath.replace(pathPrefix, filePrefix);
      }
    }
    return null;
  }

  // public urlToFilePath(url: string) {
  //   const baseUrl = this.url || `http://localhost:${this.options.port}`;
  //   if (url.startsWith(baseUrl + '/')) {
  //     return url.slice(baseUrl.length);
  //     console.info(url.slice(baseUrl.length));
  //     return this.urlPathToFilePath(url.slice(baseUrl.length));
  //   }
  //   return null;
  // }

  private static normalizeMountPoints(mountPoints: Server.MountPointOption[]): MountPoint[] {
    const finalPathSep = new RegExp(`${path.sep}$`);
    const mounts = mountPoints
      // normalize to records
      .map(mount => (typeof mount === 'string' ? { filePath: mount } : mount))
      // default url paths from file paths
      .map(mount => ({ urlPath: '/' + (mount.name || path.basename(mount.filePath)), ...mount }))
      // normalize Windows paths
      .map(mount => ({ ...mount, filePath: mount.filePath.replaceAll('/', path.sep) }))
      // remove trailing slashes from file and url paths
      .map(mount => ({
        ...mount,
        filePath: mount.filePath.replace(finalPathSep, ''),
        urlPath: mount.urlPath.replace(/\/$/, '')
      }));
    // modify url paths to ensure that they are all unique
    for (let i = mounts.length; --i >= 0; ) {
      const mount = mounts[i];
      mount.urlPath = findUniqueName(
        mount.urlPath,
        mounts.slice(i + 1).map(mount => mount.urlPath)
      );
    }
    return mounts;

    function findUniqueName(base: string, exclude: string[]): string {
      for (const name of generateNames(base)) {
        if (!exclude.includes(name)) {
          return name;
        }
      }
      return null as never;
    }

    function* generateNames(base: string) {
      yield base;
      let ix = 2;
      const m = base.match(/^(.*?)-(\d*)$/);
      if (m) {
        base = m[1];
        ix = parseInt(m[2], 10) + 1;
      }
      while (true) {
        yield `${base}-${ix++}`;
      }
    }
  }
}
