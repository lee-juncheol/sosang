// Use a supported Node runtime even when this Mac's default shell has Node 14.
// Other environments use their installed Node 22.12+ or 24+ normally.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const supported = version => { const [major,minor]=version.replace(/^v/,'').split('.').map(Number); return major>22 || major===22&&minor>=12; };
let runtime = process.execPath;
if (!supported(process.version)) {
  const bundled = resolve(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node');
  if (existsSync(bundled)) {
    const check=spawnSync(bundled,['--version'],{encoding:'utf8'});
    if (check.status===0 && supported(check.stdout.trim())) runtime=bundled;
  }
  if (runtime===process.execPath) { console.error('Node.js 22.12 이상을 설치한 뒤 다시 실행해 주세요.'); process.exit(1); }
}
const action=process.argv[2] || 'dev';
function run(args) { const result=spawnSync(runtime,args,{cwd:root,stdio:'inherit'}); if(result.error)throw result.error; if(result.status!==0)process.exit(result.status || 1); }
if (action==='build') { run(['node_modules/typescript/bin/tsc','-b']); run(['node_modules/vite/bin/vite.js','build']); run(['scripts/pack-static.mjs']); }
else if (action==='verify:assets') { run(['scripts/verify-assets.mjs',...process.argv.slice(3)]); }
else if (action==='test') { run(['--experimental-strip-types','--test','tests/lut.test.ts']); }
else if (action==='dev' || action==='preview') { run(['node_modules/vite/bin/vite.js',...(action==='preview'?['preview']:[]),'--host','127.0.0.1',...process.argv.slice(3)]); }
else { console.error('Unknown command:',action); process.exit(1); }
