import { defineConfig, type Plugin } from 'vite'

// The policy is added at build time only, because the dev server's hot reload
// needs inline scripts and a websocket that this policy forbids.
//
// connect-src names only OrcaRouter's API, so even injected code could not send
// the key anywhere else. No inline script, no eval, no third-party script.
// img-src allows https: because a provider may answer with an image link
// instead of bytes.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data: https:",
  "font-src 'self'",
  'connect-src https://api.orcarouter.ai',
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
].join('; ')

const csp = (): Plugin => ({
  name: 'darkroom-csp',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    handler: (html) => html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  },
})

export default defineConfig({
  // Relative paths, so the build works from any folder, including a GitHub Pages project URL.
  base: './',
  plugins: [csp()],
  build: {
    target: 'es2020',
    sourcemap: false,
    assetsInlineLimit: 0,
  },
})
