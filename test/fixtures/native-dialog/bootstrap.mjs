// Synthetic worker fixture: real isolation and dialog lifecycle, no SAP source.
import {NativeDynproRuntime} from '../../../tools/osd-native-dynpro.mjs';
const cell = initial => ({value:initial, get() { return this.value; }, set(value) { this.value = value; }});
let value = cell('initial');
export function boot(configuration = {}) {
  const sy = cell(Object.fromEntries(['dynnr','ucomm','pfkey','uname','mandt','langu','tcode'].map(name => [name,cell('')])));
  const engine = new NativeDynproRuntime({builtin:{sy}, compare:{initial:field => !field.get()}, context:{databaseConnections:{}}});
  engine.defineProgram({programName:'ZISOLATE', screens:[{number:'100', nextScreen:'100',
    elements:[{name:'VALUE',kind:'input',input:true,output:true,length:30}]}],
    flowLogic:[{screen:'100',steps:[{kind:'module',phase:'pai',name:'INPUT'}]}]});
  engine.registerModule('ZISOLATE','pai','INPUT',async () => {
    if (engine.system('ucomm') === 'BACK') engine.leaveScreen(0);
    if (engine.system('ucomm') === 'FAIL') throw new Error('synthetic dialog failure');
  }, {VALUE:() => value});
  return {engine, entry:async () => {
    if (configuration.showInformation) await engine.waitForInput(undefined,{
      acknowledgement:true,message:{type:'I',text:'Information before the screen'},
    });
    await engine.callScreen('ZISOLATE',100);
  }};
}
