'use strict';

// A stand-in for the parts of GitHub that Pitch talks to: the "latest release" endpoint
// (with ETag support and optional rate limiting) and asset downloads.

const http = require('node:http');
const crypto = require('node:crypto');

class MockGitHub {
  constructor() {
    this.releases = {}; // 'owner/repo' -> release JSON
    this.files = {}; // '/dl/name.zip' -> Buffer
    this.hits = []; // request log
    this.contents = {}; // 'owner/repo:path' -> { text, sha }
    this.canPush = true;
    this.rateLimited = false;
    this.downloadDelayMs = 0;
    this.server = http.createServer((req, res) => this._handle(req, res));
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${this.server.address().port}`;
    return this.base;
  }

  async stop() {
    this.server.closeAllConnections?.();
    await new Promise((resolve) => this.server.close(resolve));
  }

  // Publishes a release; `assets` = { 'Name-linux.zip': Buffer }
  publish(repo, tag, assets, { sha = true } = {}) {
    this.nextId = (this.nextId || 1000) + 1;
    const list = [];
    for (const [name, data] of Object.entries(assets)) {
      const id = ++this.nextId;
      const urlPath = `/dl/${id}/${name}`;
      this.files[urlPath] = data;
      list.push({
        id,
        name,
        size: data.length,
        url: `${this.base}/api-asset/${id}`,
        browser_download_url: `${this.base}${urlPath}`,
        content_type: 'application/zip',
        updated_at: new Date().toISOString(),
        ...(sha ? { digest: `sha256:${crypto.createHash('sha256').update(data).digest('hex')}` } : {}),
      });
    }
    this.releases[repo] = {
      tag_name: tag,
      name: `Release ${tag}`,
      body: `Notas de ${tag}`,
      published_at: new Date().toISOString(),
      html_url: `https://github.com/${repo}/releases/tag/${tag}`,
      prerelease: false,
      assets: list,
    };
  }

  _readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }

  async _contents(req, res, repo, file) {
    const key = `${repo}:${decodeURI(file)}`;
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET') {
      const entry = this.contents[key];
      if (!entry) return json(404, { message: 'Not Found' });
      return json(200, { sha: entry.sha, encoding: 'base64', content: Buffer.from(entry.text).toString('base64').replace(/(.{60})/g, '$1\n') });
    }
    if (req.method === 'PUT') {
      if (!this.canPush || !req.headers.authorization) return json(404, { message: 'Not Found' });
      const body = JSON.parse(await this._readBody(req));
      const existing = this.contents[key];
      if (existing && body.sha !== existing.sha) return json(409, { message: 'sha does not match' });
      if (!existing && body.sha) return json(422, { message: 'sha given for a new file' });
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      const sha = crypto.createHash('sha1').update(text).digest('hex');
      this.contents[key] = { text, sha };
      this.commits = (this.commits || []).concat({ repo, file, message: body.message });
      return json(200, { content: { sha } });
    }
    res.writeHead(405);
    res.end();
  }

  _handle(req, res) {
    this.hits.push({ url: req.url, ifNoneMatch: req.headers['if-none-match'] || null });
    const c = req.url.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/([^?]+)/);
    if (c) return this._contents(req, res, c[1], c[2]);
    const r = req.url.match(/^\/repos\/([^/]+\/[^/]+)$/);
    if (r) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ name: r[1].split('/')[1], owner: { login: r[1].split('/')[0] }, description: 'Un juego', html_url: `https://github.com/${r[1]}`, permissions: { push: this.canPush } }));
    }
    const m = req.url.match(/^\/repos\/([^/]+\/[^/]+)\/releases\/latest$/);
    if (m) {
      if (this.rateLimited) {
        res.writeHead(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) });
        return res.end('{"message":"rate limit exceeded"}');
      }
      const release = this.releases[m[1]];
      if (!release) {
        res.writeHead(404);
        return res.end('{"message":"Not Found"}');
      }
      const body = JSON.stringify(release);
      const etag = `"${crypto.createHash('md5').update(body).digest('hex')}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json', etag });
      return res.end(body);
    }
    const file = this.files[decodeURI(req.url)];
    if (file) {
      const send = () => {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': file.length });
        if (this.downloadDelayMs) {
          res.write(file.subarray(0, 10));
          setTimeout(() => res.end(file.subarray(10)), this.downloadDelayMs);
        } else {
          res.end(file);
        }
      };
      return send();
    }
    res.writeHead(404);
    res.end();
  }
}

module.exports = { MockGitHub };
