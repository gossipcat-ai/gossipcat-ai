// packages/dashboard/build.js
const { readFileSync, writeFileSync, mkdirSync } = require('fs');
const { join } = require('path');
const esbuild = require('esbuild');

const srcDir = join(__dirname, 'src');
const outDir = join(__dirname, '..', '..', 'dist-dashboard');

async function build() {
  // Concatenate JS files (no bundling needed — vanilla JS, no imports)
  const jsParts = [
    join(srcDir, 'app.js'),
    join(srcDir, 'lib', 'markdown.js'),
    join(srcDir, 'hub', 'overview.js'),
    join(srcDir, 'hub', 'team.js'),
    join(srcDir, 'hub', 'activity.js'),
    join(srcDir, 'hub', 'knowledge.js'),
    join(srcDir, 'detail', 'agent.js'),
    join(srcDir, 'detail', 'tasks.js'),
    join(srcDir, 'detail', 'consensus.js'),
    join(srcDir, 'detail', 'signals.js'),
    join(srcDir, 'detail', 'knowledge.js'),
  ].map(f => readFileSync(f, 'utf-8'));

  let jsBundle = jsParts.join('\n');

  // Optionally minify with esbuild
  if (process.env.NODE_ENV === 'production') {
    const minResult = await esbuild.transform(jsBundle, { minify: true, target: 'es2022' });
    jsBundle = minResult.code;
  }
  const css = readFileSync(join(srcDir, 'style.css'), 'utf-8');
  const htmlTemplate = readFileSync(join(srcDir, 'index.html'), 'utf-8');

  // Inline CSS and JS into the HTML
  const html = htmlTemplate
    .replace('<link rel="stylesheet" href="/dashboard/assets/style.css">', `<style>\n${css}\n</style>`)
    .replace('<script src="/dashboard/assets/app.js"></script>', `<script>\n${jsBundle}\n</script>`);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), html);
  console.log(`Dashboard built → ${join(outDir, 'index.html')} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
}

build().catch((err) => { console.error(err); process.exit(1); });
