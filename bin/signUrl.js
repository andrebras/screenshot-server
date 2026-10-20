#!/usr/bin/env node
const generateSignedUrl = require('../src/generateSignedUrl');
const port = process.env.SCREENSHOT_SERVER_PORT || 3001; // the port docker-compose.yml publishes

const [src, ...extraParams] = process.argv.slice(2);
if (!src) {
  process.stderr.write('usage: npm run sign -- <src-url> [name=value ...]\n');
  process.exit(1);
}

const params = {src};
extraParams.forEach((pair) => {
  const [name, ...value] = pair.split('=');
  params[name] = value.join('=');
});

process.stdout.write(`http://localhost:${port}/screenshots${generateSignedUrl(params)}\n`);
