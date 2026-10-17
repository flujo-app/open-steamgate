import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {NativeDynproSession} from '../tools/osd-native-session.mjs';
import {nativeFormInput, renderNativePage} from '../tools/osd-native-html.mjs';
import {outputFiles} from '../tools/osd-transpile.mjs';
import {mountNativeDynpro} from '../tools/osd-native-http.mjs';

const bootstrap = fileURLToPath(new URL('./fixtures/native-dialog/bootstrap.mjs', import.meta.url));
describe('native transaction worker and forms', () => {
  it('keeps an information-message continuation alive until acknowledgement', async () => {
    const session = new NativeDynproSession({bootstrap,showInformation:true});
    try {
      const message=await session.start();
      assert.equal(message.kind,'message');
      assert.equal(session.terminal,undefined);
      const html=renderNativePage({path:'/native',csrf:'nonce',transactions:{ZDEMO:{}},event:message});
      assert.match(html,/Information before the screen/);
      assert.match(html,/>OK<\/button>/);
      const body=new URLSearchParams({revision:String(message.revision),action:'resume',csrf:'nonce',command:''});
      const screen=await session.resume(nativeFormInput(message,body));
      assert.equal(screen.kind,'screen');
      body.set('command','RUN');
      assert.throws(() => nativeFormInput(message,body),/acknowledgement/);
    } finally { await session.close(); }
  });

  it('isolates program globals and resumes the suspended caller', async () => {
    const first = new NativeDynproSession({bootstrap}), second = new NativeDynproSession({bootstrap});
    try {
      const a = await first.start(), b = await second.start();
      const changed = await first.resume({revision:a.revision,fields:{VALUE:'changed'}});
      assert.equal(changed.screen.elements[0].value,'changed');
      const unchanged = await second.resume({revision:b.revision});
      assert.equal(unchanged.screen.elements[0].value,'initial');
      assert.deepEqual(await first.resume({revision:changed.revision,command:'BACK'}),{kind:'complete'});
      await assert.rejects(first.resume({revision:changed.revision}),/ended/);
      assert.equal((await second.resume({revision:unchanged.revision,command:'FAIL'})).error.message,'synthetic dialog failure');
    } finally { await Promise.allSettled([first.close(), second.close()]); }
  });

  it('closes a worker waiting on user input and refuses further requests', async () => {
    const session = new NativeDynproSession({bootstrap});
    const screen = await session.start();
    await session.close();
    assert.equal(session.closed,true);
    await assert.rejects(session.resume({revision:screen.revision}),/ended/);
  });

  it('shares the native bootstrap between dynamic and static initialization', () => {
    const output = {objects:[], initializationScript:'import runtime from "@abaplint/runtime";\nglobalThis.abap = new runtime.ABAP();\nawait import("./zgroup.fugr.mjs");',
      initializationScript2:'import "./_top.mjs";\nimport "./zgroup.fugr.mjs";'};
    const native = outputFiles(output,{options:{nativeDynpro:true}},'out',[]);
    const contents = suffix => native.find(file => file.path.endsWith(suffix)).contents;
    assert.match(contents('init.mjs'),/await import\("\.\/_top.mjs"\)/);
    assert.doesNotMatch(contents('init.mjs'),/new runtime.ABAP/);
    assert.match(contents('_top.mjs'),/new NativeDynproRuntime/);
    assert.match(contents('_dynpro-runtime.mjs'),/export class NativeDynproRuntime/);
    const ordinary = outputFiles(output,{options:{}},'out',[]);
    assert.equal(ordinary.some(file => file.path.endsWith('_dynpro-runtime.mjs')),false);
    assert.equal(ordinary.find(file => file.path.endsWith('init.mjs')).contents,output.initializationScript);
  });

  const event = {kind:'screen', revision:7, title:'Form <example>', screen:{elements:[
    {kind:'input-output',name:'NAME',input:true,output:true,value:'old',length:20},
    {kind:'radio',name:'MODE_A',input:true,output:true,value:'X',text:'First',attributes:{contName:'MODE'}},
    {kind:'radio',name:'MODE_B',input:true,output:true,value:' ',text:'Second',attributes:{contName:'MODE'}},
  ]}};
  const body = () => new URLSearchParams({revision:'7',action:'resume',csrf:'nonce','field:NAME':'old','radio:MODE':'MODE_B'});
  it('transports changed fields and the entire selected radio group', () => {
    assert.deepEqual(nativeFormInput(event,body()),{revision:7,command:'',fields:{MODE_A:'',MODE_B:'X'}});
    const duplicate = body(); duplicate.append('field:NAME','extra');
    assert.throws(() => nativeFormInput(event,duplicate),/duplicate/);
    const stale = body(); stale.set('revision','6');
    assert.throws(() => nativeFormInput(event,stale),/changed/);
    const forged = body(); forged.set('radio:MODE','FORGED');
    assert.throws(() => nativeFormInput(event,forged),/Invalid radio/);
  });
  it('escapes data and keeps a nonce and screen revision in each form', () => {
    const html = renderNativePage({path:'/sap/bc/osd/native-dynpro',csrf:'nonce',transactions:{ZDEMO:{}},event});
    assert.match(html,/Form &lt;example&gt;/);
    assert.match(html,/name="csrf" value="nonce"/);
    assert.match(html,/name="revision" value="7"/);
    assert.match(html,/type="radio" name="radio:MODE" value="MODE_A" checked/);
    assert.throws(() => renderNativePage({path:'/',csrf:'n',transactions:{},event:{...event,controlsHtml:'<section>Control</section>'}}),/not connected/);
  });

  it('requires the session nonce and rejects stale forms before resuming ABAP', async () => {
    let handler, starts = 0, resumes = 0, closes = 0;
    const app = {all(_path, callback) { handler = callback; }};
    const service = mountNativeDynpro(app,'/sap/bc/osd/native-dynpro',{
      file:fileURLToPath(new URL('./fixtures/native-dialog/config.json',import.meta.url)),
      createSession:() => ({async start() { starts++; return event; },
        async resume(input) { resumes++; return {...event, revision:input.revision + 1}; },
        async close() { closes++; }}),
    });
    const request = async (method, cookie, data) => {
      const answer = {statusCode:200, headers:{}, status(code) { this.statusCode = code; return this; },
        set(name,value) { this.headers[name] = value; return this; }, append(name,value) { return this.set(name,value); },
        type() { return this; }, send(body) { this.body = body; return this; }, end() { return this; }};
      await handler({method, headers:{cookie, 'content-type':'application/x-www-form-urlencoded'},
        body:data === undefined ? undefined : Buffer.from(new URLSearchParams(data).toString())}, answer);
      return answer;
    };
    try {
      const page = await request('GET');
      const cookie = page.headers['Set-Cookie'].split(';')[0];
      const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)[1];
      assert.equal((await request('POST',cookie,{csrf:'wrong',action:'start',transaction:'ZDEMO'})).statusCode,403);
      assert.equal(starts,0);
      assert.equal((await request('POST',cookie,{csrf,action:'start',transaction:'ZDEMO'})).statusCode,200);
      assert.equal(starts,1);
      const input = {csrf,action:'resume',revision:'6','field:NAME':'old','radio:MODE':'MODE_A'};
      assert.equal((await request('POST',cookie,input)).statusCode,409);
      assert.equal(resumes,0);
      input.revision = '7';
      assert.equal((await request('POST',cookie,input)).statusCode,200);
      assert.equal(resumes,1);
      assert.equal((await request('POST',cookie,{csrf,action:'close',revision:'7'})).statusCode,409);
      assert.equal(closes,0);
      assert.equal((await request('POST',cookie,{csrf,action:'close',revision:'8'})).statusCode,200);
      assert.equal(closes,1);
    } finally { await service.close(); }
  });
});
