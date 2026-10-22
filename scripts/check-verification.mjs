import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, chmod, readdir, rm, stat, symlink, cp, realpath } from 'node:fs/promises';
import { join, dirname, delimiter, parse } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let version;
try {
  version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).piRuntimeVersion;
} catch {
  throw new Error('Cannot read piRuntimeVersion from the source package.json.');
}
if (typeof version !== 'string' || !version) throw new Error('Source package.json must declare piRuntimeVersion.');
const sdk = process.env.PI_PACKAGE_DIR ?? join(root, 'install', 'releases', version, 'node_modules', '@earendil-works', 'pi-coding-agent');
const { parseInvocation, resolveOptions } = await import(pathToFileURL(join(root,'extensions/verification-runtime/options.mjs')));
const { localUrl, fileReference, resolveAuth, runLocalCurl } = await import(pathToFileURL(join(root,'extensions/verification-runtime/http.mjs')));
const runtimeAgentDir = fileReference(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), process.cwd());
const subagents = join(runtimeAgentDir, 'npm', 'node_modules', 'pi-subagents', 'src', 'agents', 'agents.js');
const levels = ['off','minimal','low','medium','high','xhigh','max'];
const require = createRequire(join(sdk, 'package.json'));
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url,{fsCache:false,moduleCache:false,alias:{
  '@earendil-works/pi-ai': join(dirname(dirname(sdk)), '@earendil-works', 'pi-ai', 'dist', 'index.js'),
  '@earendil-works/pi-coding-agent': join(sdk, 'dist', 'index.js'),
}});
const { default: install } = await jiti.import(join(root,'extensions/verification-runtime/index.ts'));
const { loadSkillsFromDir, formatSkillsForPrompt } = await import(pathToFileURL(join(sdk, 'dist/core/skills.js')));

async function skillPolicy(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-skill-policy-')));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const previous = process.env.PI_CODING_AGENT_DIR;
  let handler;
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    const { default: installPolicy } = await jiti.import(join(root, 'extensions/manual-skills/index.ts'));
    installPolicy({on: (name, callback) => { if (name === 'before_agent_start') handler = callback; }});
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
  assert.equal(typeof handler, 'function');
  return {
    dir,
    async skill(base, name, manual = false) {
      const directory = join(dir, base, name);
      await mkdir(directory, {recursive:true});
      await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture helper.\ndisable-model-invocation: ${manual}\n---\n\n# Fixture\n\nBODY_ONLY_NOT_ADVERTISED\n`);
      const loaded = loadSkillsFromDir({dir:directory, source:'fixture'});
      assert.deepEqual(loaded.diagnostics, []);
      return loaded.skills[0];
    },
    apply(skills) {
      const event = {systemPromptOptions:{skills}};
      handler(event);
      return event.systemPromptOptions.skills;
    },
  };
}

function runtime(cwd) {
  let level='medium';
  const tools = new Map(), events = new Map();
  const pi={ registerTool: tool=>tools.set(tool.name,tool), on:(name,handler)=>{events.set(name,handler);return()=>{};}, getThinkingLevel:()=>level, setThinkingLevel:value=>{level=value;} };
  install(pi);
  const ctx={cwd,model:{provider:'fixture',id:'reasoner',reasoning:true,thinkingLevelMap:{xhigh:'xhigh',max:'max'}}};
  return {pi,ctx,events,call:(name,input,signal)=>tools.get(name).execute('fixture',input,signal,undefined,ctx),tools};
}
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(),'pi-verification-fixture-')));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const jwt=[{alg:'HS256',typ:'JWT'},{sub:'synthetic-check-only'},'dummy-signature'].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  const jwtFile=join(dir,'local.jwt');
  await writeFile(jwtFile,jwt,{mode:0o600});
  const requests=[];
  const server=createServer((req,res)=>{
    const body=[];
    req.on('data',part=>body.push(part));
    req.on('end',()=>{
      requests.push({url:req.url,method:req.method,auth:req.headers.authorization,key:req.headers['x-api-key'],body:Buffer.concat(body).toString()});
      res.setHeader('Content-Type','application/json');
      res.setHeader('Set-Cookie','synthetic-cookie-not-for-model');
      if(req.url==='/redirect'){res.writeHead(302,{Location:'/redirect-target'});res.end();return;}
      if(req.url==='/unauthorized'){res.writeHead(401);res.end('{"error":"unauthorized"}');return;}
      if(req.url==='/forbidden'){res.writeHead(403);res.end('{"error":"forbidden"}');return;}
      if(req.url==='/invalid'){res.writeHead(422);res.end('{"error":"invalid"}');return;}
      if(req.url==='/slow'){setTimeout(()=>{if(!res.destroyed)res.end('{}');},1200).unref();return;}
      res.end(JSON.stringify({ok:true,echo:req.headers.authorization,token:'new-generated-secret',nested:{password:'private'},key:req.headers['x-api-key']}));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base=`http://127.0.0.1:${server.address().port}`;
  const run=async input=>{
    const report=await runLocalCurl({url:base+'/',jwtFile,...input},dir);
    t.after(()=>rm(dirname(report.reportFile),{recursive:true,force:true}));
    return report;
  };
  return {dir,jwt,jwtFile,requests,base,run};
}

test('options: ask for mode and real effort in both review modes',()=>{
  assert.deepEqual(resolveOptions({skill:'code-review'},levels).missing,['mode','effort']);
  assert.deepEqual(resolveOptions({skill:'code-review',arguments:'--inline'},levels).missing,['effort']);
  assert.deepEqual(resolveOptions({skill:'code-review',arguments:'--agent'},levels).missing,['effort']);
});
test('options: explicit flags skip questions; quoted scope and equals syntax',()=>{
  const p=resolveOptions({skill:'code-review',arguments:'--inline --effort=high -- "chosen files"'},levels);
  assert.equal(p.ready,true);assert.equal(p.effort,'high');assert.equal(p.target,'chosen files');
  assert.equal(parseInvocation('tester','--agent "some tests"').mode,'agent');
});
test('options: verify asks checks, recommends agents, preserves mixed contexts',()=>{
  const p=resolveOptions({skill:'verify'},levels);
  assert.deepEqual(p.missing,['checks','mode']);assert.equal(p.recommendedMode,'agent');
  assert.deepEqual(p.contexts,{review:'fork',tests:'fresh',curl:'fresh'});
});
test('options: selected non-review checks do not acquire effort',()=>{
  const p=resolveOptions({skill:'verify',arguments:'--agent --checks tests,curl'},levels);
  assert.equal(p.ready,true);assert.equal(p.effort,undefined);
  assert.deepEqual(resolveOptions({skill:'tester'},levels).missing,['mode']);
  assert.deepEqual(resolveOptions({skill:'curler'},levels).missing,['mode']);
});
test('options: flag conflicts, unknown flags and absent values fail closed',()=>{
  for(const input of ['--agent --inline','--effort','--checks','--effort=','--effort high --effort low','--unexpected']){
    assert.throws(()=>resolveOptions({skill:'verify',arguments:input},levels));
  }
  assert.throws(()=>parseInvocation('tester','--checks tests'));
  assert.throws(()=>parseInvocation('curler','"unterminated'));
});
test('options: only review accepts effort; unsupported values never clamp',()=>{
  for(const skill of ['tester','curler']) assert.throws(()=>resolveOptions({skill,arguments:'--agent --effort high'},levels));
  assert.throws(()=>resolveOptions({skill:'verify',arguments:'--agent --checks tests --effort high'},levels));
  assert.throws(()=>resolveOptions({skill:'code-review',arguments:'--inline --effort max'},['low','medium','high']));
  assert.throws(()=>resolveOptions({skill:'code-review',arguments:'--inline --effort cosmic'},levels));
});
test('options: ask cannot override explicit flags or choose empty checks',()=>{
  assert.throws(()=>resolveOptions({skill:'tester',arguments:'--agent',mode:'inline'},levels));
  assert.throws(()=>resolveOptions({skill:'verify',checks:[]},levels));
  assert.equal(resolveOptions({skill:'code-review',arguments:'--inline',effort:'high'},levels).ready,true);
});
test('runtime: loads four tools and supplies exact source paths/model effort',async()=>{
  const r=runtime(root);assert.equal(r.tools.size,4);
  const result=await r.call('verification_options',{skill:'verify',arguments:'--agent --checks review,tests,curl --effort max'});
  assert.equal(result.isError,false);assert.equal(result.details.reviewModel,'fixture/reasoner:max');
  for(const entry of Object.values(result.details.executors)) assert.equal((await stat(entry.skillFile)).isFile(),true);
  const natural=await r.call('verification_options',{skill:'code-review',arguments:'Делай ревью агентом на высокой производительности',mode:'agent',effort:'high'});
  assert.equal(natural.isError,false);assert.equal(natural.details.ready,true);assert.deepEqual(natural.details.missing,[]);
  assert.equal(natural.details.mode,'agent');assert.equal(natural.details.reviewModel,'fixture/reasoner:high');
});
test('runtime: actual inline thinking level is applied and restored',async()=>{
  const r=runtime(root),begin=await r.call('verification_effort',{action:'begin',level:'high'});
  assert.equal(r.pi.getThinkingLevel(),'high');
  assert.equal((await r.call('verification_effort',{action:'begin',level:'low'})).isError,true);
  assert.equal((await r.call('verification_effort',{action:'end',lease:'wrong'})).isError,true);
  await r.call('verification_effort',{action:'end',lease:begin.details.lease});
  assert.equal(r.pi.getThinkingLevel(),'medium');
});
test('runtime: settles restore effort; later manual changes are preserved',async()=>{
  const r=runtime(root);await r.call('verification_effort',{action:'begin',level:'high'});
  r.events.get('agent_settled')({},r.ctx);assert.equal(r.pi.getThinkingLevel(),'medium');
  const begin=await r.call('verification_effort',{action:'begin',level:'high'});
  r.pi.setThinkingLevel('low');await r.call('verification_effort',{action:'end',lease:begin.details.lease});
  assert.equal(r.pi.getThinkingLevel(),'low');
});
test('runtime: rejected level leaves current thinking unchanged',async()=>{
  const r=runtime(root);r.ctx.model.reasoning=false;
  const result=await r.call('verification_effort',{action:'begin',level:'high'});
  assert.equal(result.isError,true);assert.equal(r.pi.getThinkingLevel(),'medium');
});
test('auth: metadata resolves paths without reading the JWT',async t=>{
  const f=await fixture(t),meta=join(f.dir,'verification.json');
  await writeFile(meta,JSON.stringify({jwtFile:'./local.jwt',baseUrl:f.base}));
  await chmod(f.jwtFile,0o000);
  const result=await resolveAuth({configFile:meta},f.dir);
  await chmod(f.jwtFile,0o600);
  assert.equal(result.status,'ready');assert.equal(result.jwtFile,f.jwtFile);
  assert.equal(JSON.stringify(result).includes(f.jwt),false);assert.equal(f.requests.length,0);
});
test('auth: missing reference blocks, with no anonymous fallback',async t=>{
  const f=await fixture(t),r=await resolveAuth({configFile:join(f.dir,'missing.json')},f.dir);
  assert.equal(r.status,'blocked');assert.equal(f.requests.length,0);
  await assert.rejects(()=>f.run({jwtFile:join(f.dir,'missing.jwt')}));assert.equal(f.requests.length,0);
});
test('auth: explicit none needs no credentials and skips metadata discovery',async t=>{
  const f=await fixture(t);await mkdir(join(f.dir,'.paiw'));
  await writeFile(join(f.dir,'.paiw','verification.json'),'invalid metadata must not be read');
  const result=await runtime(f.dir).call('verification_auth',{authMode:'none'});
  assert.equal(result.isError,false);assert.equal(result.details.status,'ready');
  assert.equal(result.details.authMode,'none');assert.equal(result.details.source,undefined);
  assert.equal(result.details.jwtFile,undefined);assert.deepEqual(result.details.headerFiles,[]);
  assert.equal(f.requests.length,0);
});
test('auth: none refuses credential references, including metadata',async t=>{
  const f=await fixture(t);
  await assert.rejects(()=>resolveAuth({authMode:'none',jwtFile:f.jwtFile},f.dir),/режиме none/);
  await assert.rejects(()=>resolveAuth({authMode:'none',headerFiles:[{name:'X-Api-Key',file:f.jwtFile}]},f.dir),/режиме none/);
  const meta=join(f.dir,'conflicting.json');await writeFile(meta,JSON.stringify({authMode:'none',jwtFile:'./local.jwt'}));
  await assert.rejects(()=>resolveAuth({configFile:meta},f.dir),/режиме none/);
  assert.equal(f.requests.length,0);
});
test('auth: invalid metadata never reflects its raw contents',async t=>{
  const f=await fixture(t),file=join(f.dir,'bad.json');await writeFile(file,f.jwt);
  try{await resolveAuth({configFile:file},f.dir);assert.fail('expected refusal');}catch(error){assert.equal(error.message.includes(f.jwt),false);}
  await writeFile(file,JSON.stringify({jwt:f.jwt}));
  await assert.rejects(()=>resolveAuth({configFile:file},f.dir),/только jwtFile/);
});
test('auth: local PAIW metadata lookup uses file references only',async t=>{
  const f=await fixture(t);await mkdir(join(f.dir,'.paiw'));
  await writeFile(join(f.dir,'.paiw','verification.json'),JSON.stringify({jwtFile:'../local.jwt'}));
  const auth=await resolveAuth({},f.dir);assert.equal(auth.jwtFile,f.jwtFile);assert.equal(auth.status,'ready');
});
test('auth: ordinary dotted filenames are paths, not JWT values',()=>{
  assert.equal(fileReference('local.auth.txt','/tmp'),'/tmp/local.auth.txt');
});
test('runtime: direct and symlink reads/searches of resolved secrets are blocked',async t=>{
  const f=await fixture(t),r=runtime(f.dir),alias=join(f.dir,'alias');await symlink(f.jwtFile,alias);
  const auth=await r.call('verification_auth',{jwtFile:alias});assert.equal(auth.isError,false);
  for(const path of [alias,f.jwtFile]) assert.equal(r.events.get('tool_call')({toolName:'read',input:{path}},r.ctx).block,true);
  assert.equal(r.events.get('tool_call')({toolName:'grep',input:{path:f.dir}},r.ctx).block,true);
  assert.equal(r.events.get('tool_call')({toolName:'grep',input:{}},r.ctx).block,true);
  assert.equal(r.events.get('tool_call')({toolName:'grep',input:{path:parse(f.dir).root}},r.ctx).block,true);
  assert.equal(r.events.get('tool_call')({toolName:'read',input:{path:join(root,'package.json')}},r.ctx),undefined);
});
test('HTTP: refuses external hosts, credential URLs and secret query keys',()=>{
  for(const url of ['https://example.invalid/','file:///tmp/file','http://user:pass@localhost/','http://localhost/?token=foo','http://localhost/#secret','http://localhost.example.invalid/']) assert.throws(()=>localUrl(url));
  for(const url of ['http://127.0.0.1:1234/','http://localhost/','http://[::1]/']) assert.doesNotThrow(()=>localUrl(url));
});
test('HTTP: positive request sends JWT without exposing it in the report',async t=>{
  const f=await fixture(t),report=await f.run({});
  assert.equal(report.outcome,'passed');assert.equal(report.exitCode,0);assert.equal(report.httpStatus,200);
  assert.equal(f.requests[0].auth===`Bearer ${f.jwt}`,true);
  assert.equal(JSON.stringify(report).includes(f.jwt),false);
  assert.equal(report.response.includes('new-generated-secret'),false);assert.equal(report.response.includes('private'),false);
  assert.equal((await readFile(report.reportFile,'utf8')).includes(f.jwt),false);
  assert.deepEqual(await readdir(dirname(report.reportFile)),['report.json']);
  assert.equal((await stat(report.reportFile)).mode & 0o777,0o600);
  assert.equal((await stat(dirname(report.reportFile))).mode & 0o777,0o700);
});
test('HTTP: explicitly approved none sends no authorization through the registered tool',async t=>{
  const f=await fixture(t),result=await runtime(f.dir).call('verification_curl',{
    url:f.base+'/public',authMode:'none',authApproved:true,expectedStatus:200,
  });
  const report=result.details;
  if(report.reportFile)t.after(()=>rm(dirname(report.reportFile),{recursive:true,force:true}));
  assert.equal(result.isError,false);assert.equal(report.outcome,'passed');
  assert.equal(report.exitCode,0);assert.equal(report.httpStatus,200);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].auth,undefined);assert.equal(f.requests[0].key,undefined);
  assert.equal(JSON.parse(report.response).ok,true);assert.equal(JSON.stringify(report).includes(f.jwt),false);
});
test('HTTP: none requires prior approval even when selected by metadata',async t=>{
  const f=await fixture(t);
  await assert.rejects(()=>runLocalCurl({url:f.base,authMode:'none'},f.dir),/согласованы/);
  const meta=join(f.dir,'public.json');await writeFile(meta,JSON.stringify({authMode:'none'}));
  const result=await runtime(f.dir).call('verification_curl',{url:f.base,configFile:meta});
  assert.equal(result.isError,true);assert.equal(result.details.outcome,'blocked');
  assert.match(result.details.reason,/согласованы/);assert.equal(f.requests.length,0);
});
test('HTTP: redirect is not followed',async t=>{
  const f=await fixture(t),report=await f.run({url:f.base+'/redirect'});
  assert.equal(report.httpStatus,302);assert.equal(report.outcome,'failed');assert.equal(f.requests.length,1);
});
test('HTTP: 401/403 are authorization blockers, expected 422 can pass',async t=>{
  const f=await fixture(t);
  for(const path of ['/unauthorized','/forbidden']) assert.equal((await f.run({url:f.base+path})).outcome,'blocked');
  assert.equal((await f.run({url:f.base+'/invalid',expectedStatus:422})).outcome,'passed');
});
test('HTTP: HEAD does not return response headers',async t=>{
  const f=await fixture(t),report=await f.run({method:'HEAD'});
  assert.equal(report.outcome,'passed');assert.equal(report.response,'');
});
test('HTTP: mutations require prior approval; approved body stays separate from secrets',async t=>{
  const f=await fixture(t);await assert.rejects(()=>f.run({method:'POST'}),/разрешение/);assert.equal(f.requests.length,0);
  const bodyFile=join(f.dir,'request.json');await writeFile(bodyFile,'{"id":42}');
  const report=await f.run({method:'POST',mutationApproved:true,bodyFile,contentType:'application/json'});
  assert.equal(report.outcome,'passed');assert.equal(f.requests[0].body,'{"id":42}');
});
test('HTTP: extra credentials and non-JWT auth need explicit approval',async t=>{
  const f=await fixture(t),keyFile=join(f.dir,'key.txt');await writeFile(keyFile,'synthetic-extra-key',{mode:0o600});
  const headerFiles=[{name:'X-Api-Key',file:keyFile}];
  await assert.rejects(()=>f.run({headerFiles}),/согласованы/);assert.equal(f.requests.length,0);
  const report=await f.run({headerFiles,authApproved:true});assert.equal(report.outcome,'passed');
  assert.equal(f.requests[0].key,'synthetic-extra-key');assert.equal(JSON.stringify(report).includes('synthetic-extra-key'),false);
  const other=await runLocalCurl({url:f.base,authMode:'headers',headerFiles,authApproved:true},f.dir);
  t.after(()=>rm(dirname(other.reportFile),{recursive:true,force:true}));assert.equal(other.outcome,'passed');
});
test('HTTP: invalid credentials, header injection and credential bodies refuse before network',async t=>{
  const f=await fixture(t),bad=join(f.dir,'bad.jwt');await writeFile(bad,'not-a-jwt');
  await assert.rejects(()=>f.run({jwtFile:bad}));
  await writeFile(bad,'one\r\nInjected: value');await assert.rejects(()=>f.run({jwtFile:bad}));
  await assert.rejects(()=>f.run({method:'POST',mutationApproved:true,bodyFile:f.jwtFile}));
  await assert.rejects(()=>f.run({contentType:'application/json\r\nInjected: value'}));
  await assert.rejects(()=>f.run({headerFiles:[{name:'Host',file:f.jwtFile}],authApproved:true}));
  assert.equal(f.requests.length,0);
});
test('HTTP: timeout and cancellation settle without exposing credentials',async t=>{
  const f=await fixture(t),report=await f.run({url:f.base+'/slow',timeoutSeconds:1});
  assert.equal(report.outcome,'failed');assert.notEqual(report.exitCode,0);assert.equal(JSON.stringify(report).includes(f.jwt),false);
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>runLocalCurl({url:f.base,jwtFile:f.jwtFile},f.dir,controller.signal));
});
test('HTTP: argv contains file references, not credentials; private files are removed',async t=>{
  const f=await fixture(t),bin=join(f.dir,'bin'),capture=join(f.dir,'argv.json');await mkdir(bin);
  await writeFile(join(bin,'curl'),`#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.writeFileSync(process.env.VERIFICATION_CAPTURE,JSON.stringify(a));const h=fs.readFileSync(a[a.indexOf('--header')+1].slice(1),'utf8');fs.writeFileSync(a[a.indexOf('--output')+1],JSON.stringify({echo:h}));process.stdout.write('200');\n`,{mode:0o700});
  const oldPath=process.env.PATH,oldCapture=process.env.VERIFICATION_CAPTURE;
  try{
    process.env.PATH=bin+delimiter+oldPath;process.env.VERIFICATION_CAPTURE=capture;
    const report=await f.run({});const args=JSON.parse(await readFile(capture,'utf8'));
    assert.equal(JSON.stringify(args).includes(f.jwt),false);assert.equal(JSON.stringify(report).includes(f.jwt),false);
    assert.equal(args[0],'--disable');assert.equal(args.includes('--noproxy'),true);assert.equal(args.includes('--location'),false);
    const header=args[args.indexOf('--header')+1].slice(1);await assert.rejects(()=>stat(header));
  }finally{process.env.PATH=oldPath;if(oldCapture===undefined)delete process.env.VERIFICATION_CAPTURE;else process.env.VERIFICATION_CAPTURE=oldCapture;}
});
test('profiles: strict independent roles, fresh validators and fork reviewer',async()=>{
  for(const [name,context] of [['code-reviewer','fork'],['tester','fresh'],['curler','fresh']]){
    const text=await readFile(join(root,'agents',name+'.md'),'utf8');
    assert.equal(text.includes('defaultContext: '+context),true);assert.equal(/^allowedAgents:\s*$/m.test(text),true);
    const tools=/^tools: (.+)$/m.exec(text)[1].split(', ');assert.equal(tools.includes('subagent'),false);
    if(name==='curler'){assert.equal(tools.includes('bash'),false);assert.equal(tools.includes('grep'),false);assert.equal(tools.includes('verification_curl'),true);}
  }
});
test('manual-skills extension: common and work sources retain their declared invocation policy', async t => {
  const policy = await skillPolicy(t);
  const automatic = await policy.skill('skills', 'our-helper');
  const manual = await policy.skill('skills', 'our-mode', true);
  const work = await policy.skill('work/skills', 'our-work-helper');
  const actual = policy.apply([automatic, manual, work]);
  assert.deepEqual(actual.map(skill => skill.disableModelInvocation), [false, true, false]);
  assert.equal(actual[0], automatic);
});
test('manual-skills extension: external, managed and symlinked sources keep their previous manual policy', async t => {
  const policy = await skillPolicy(t);
  const external = await policy.skill('external', 'foreign-helper');
  const managed = await policy.skill('skills/paiw', 'managed-helper');
  const hidden = await policy.skill('external', 'swe-helper');
  const alias = join(policy.dir, 'skills', 'linked-helper');
  await symlink(external.baseDir, alias);
  const linked = {...external, name:'linked-helper', filePath:join(alias, 'SKILL.md')};
  const missing = {...external, name:'missing-helper', filePath:join(policy.dir, 'skills/missing/SKILL.md')};
  const actual = policy.apply([external, managed, linked, missing, hidden]);
  assert.deepEqual(actual.map(skill => [skill.name, skill.disableModelInvocation]), [
    ['foreign-helper', true], ['managed-helper', true], ['linked-helper', true], ['missing-helper', true],
  ]);
});
test('manual-skills extension: native prompt advertises allowed metadata without full instruction bodies', async t => {
  const policy = await skillPolicy(t);
  const automatic = await policy.skill('skills', 'automatic-helper');
  const manual = await policy.skill('skills', 'explicit-mode', true);
  const external = await policy.skill('external', 'external-helper');
  const prompt = formatSkillsForPrompt(policy.apply([automatic, manual, external]));
  assert.equal(prompt.includes('<name>automatic-helper</name>'), true);
  assert.equal(prompt.includes('<name>explicit-mode</name>'), false);
  assert.equal(prompt.includes('<name>external-helper</name>'), false);
  assert.equal(prompt.includes('BODY_ONLY_NOT_ADVERTISED'), false);
});

test('real Pi extension loader accepts the component without model calls',async()=>{
  const {loadExtensions}=await import(pathToFileURL(join(sdk,'dist/core/extensions/loader.js')));
  const loaded=await loadExtensions([join(root,'extensions/verification-runtime/index.ts'),join(root,'extensions/manual-skills/index.ts')],root);
  assert.deepEqual(loaded.errors,[]);assert.equal(loaded.extensions.length,2);assert.equal(loaded.extensions[0].tools.size,4);
  assert.equal(loaded.extensions[1].handlers.has('before_agent_start'),true);
});
test('real pi-subagents discovery accepts all three native profiles',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pi-verification-discovery-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const agentDir=join(dir,'agent');await mkdir(agentDir);await cp(join(root,'agents'),join(agentDir,'agents'),{recursive:true});
  const old=process.env.PI_CODING_AGENT_DIR;
  try{
    process.env.PI_CODING_AGENT_DIR=agentDir;
    const m=await jiti.import(subagents);
    m.clearAgentDiscoveryCache();const found=m.discoverAgents(dir,'user','fixture',{includeChains:false});
    for(const name of ['code-reviewer','tester','curler']) assert.equal(found.agents.some(agent=>agent.name===name),true);
    const problems=(found.agentDiagnostics??[]).filter(d=>d.filePath?.startsWith(agentDir));assert.deepEqual(problems,[]);
  }finally{if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;}
});
test('real pi-subagents package metadata discovers profiles outside the user agent directory',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pi-verification-package-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const agentDir=join(dir,'agent');await mkdir(agentDir);await writeFile(join(agentDir,'settings.json'),JSON.stringify({packages:[root]}));
  const old=process.env.PI_CODING_AGENT_DIR;
  try{
    process.env.PI_CODING_AGENT_DIR=agentDir;
    const m=await jiti.import(subagents);
    m.clearAgentDiscoveryCache();const found=m.discoverAgents(dir,'both','fixture',{includeChains:false});
    for(const [name,context] of [['code-reviewer','fork'],['tester','fresh'],['curler','fresh']]){
      const agent=found.agents.find(agent=>agent.name===name);
      assert.equal(agent?.source,'package');assert.equal(agent.defaultContext,context);assert.deepEqual(agent.allowedAgents,[]);
    }
    assert.deepEqual((found.agentDiagnostics??[]).filter(d=>d.filePath?.startsWith(join(root,'agents'))),[]);
  }finally{if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;}
});
