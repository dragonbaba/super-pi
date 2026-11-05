import assert from "node:assert/strict";
import test from "node:test";
import { CodemodeSandbox } from "../packages/codemode/src/runtime/host.ts";
import { MAX_TIMERS } from "../packages/codemode/src/limits.ts";

test("bounded timers resolve waits, carry callback arguments, cancel and leave no stale callback in a pooled worker", async () => {
	const sandbox = new CodemodeSandbox({reuseWorker:true, timeoutMode:"active"});
	try {
		const result = await sandbox.execute(`
			const start=Date.now();
			const cancelled=setTimeout(()=>{throw new Error("cancelled callback")},1); clearTimeout(cancelled); clearTimeout(cancelled);
			const value=await new Promise(resolve=>setTimeout(resolve,25,"delayed"));
			setTimeout(()=>{throw new Error("unawaited callback")},10);
			return [value,Date.now()-start>=20,typeof setInterval];
		`);
		assert.ok(result.ok, JSON.stringify(result)); assert.deepEqual(result.value,["delayed",true,"undefined"]);
		assert.equal(result.calls.length,0);
		const next = await sandbox.execute('await new Promise(resolve=>setTimeout(resolve,50)); return "fresh"');
		assert.ok(next.ok, JSON.stringify(next)); assert.equal(next.value,"fresh");
		assert.equal(sandbox.stats.workersStarted,1);
	} finally {await sandbox.close();}
	assert.deepEqual(sandbox.stats,{activeExecutions:0,workersStarted:1,workersStopped:1});
});

test("timer quota, invalid arguments, callback throws and cancelled-only waits fail without leaking owners", async () => {
	const sandbox = new CodemodeSandbox({reuseWorker:true});
	try {
		for (const [code, message] of [
			[`for(let i=0;i<=${MAX_TIMERS};i++) clearTimeout(setTimeout(()=>{},0))`,"timer limit"],
			['setTimeout("text(1)",1)',"function callback"],
			['setTimeout(()=>{},NaN)',"delay must"],
			['setTimeout(()=>{},300001)',"delay must"],
			['await new Promise(()=>setTimeout(()=>{throw new Error("callback failure")},1))',"callback failure"],
			['await new Promise(resolve=>clearTimeout(setTimeout(resolve,10)))',"no tool call or timer is pending"],
		]) {
			const result=await sandbox.execute(code!); assert.ok(!result.ok); assert.ok(result.error.message.includes(message!),JSON.stringify(result));
			assert.equal(sandbox.stats.workersStarted,sandbox.stats.workersStopped);
		}
	} finally {await sandbox.close();}
});

test("timer waits consume the active budget even while a host tool is pending; abort releases the worker", async () => {
	const sandbox = new CodemodeSandbox({reuseWorker:true,timeoutMode:"active",tools:[{name:"blocked",execute:()=>new Promise(()=>{})}]});
	try {
		for(const code of ['await new Promise(resolve=>setTimeout(resolve,5000))', 'tools.blocked(); await new Promise(resolve=>setTimeout(resolve,5000))']) {
			const result=await sandbox.execute(code,{timeoutMs:250}); assert.ok(!result.ok); assert.equal(result.error.kind,"timeout");
			assert.equal(sandbox.stats.workersStarted,sandbox.stats.workersStopped);
		}
		const controller=new AbortController();
		const pending=sandbox.execute('await new Promise(resolve=>setTimeout(resolve,5000))',{signal:controller.signal});
		const timer=setTimeout(()=>controller.abort(),100);
		try {const result=await pending; assert.ok(!result.ok); assert.equal(result.error.kind,"aborted");}
		finally {clearTimeout(timer);}
	} finally {await sandbox.close();}
	assert.equal(sandbox.stats.activeExecutions,0); assert.equal(sandbox.stats.workersStarted,sandbox.stats.workersStopped);
});
