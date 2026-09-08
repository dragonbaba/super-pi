import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { Agent } from "../../packages/agent/src/agent.ts";
import { AssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.ts";
import type { AssistantMessage, Model, Api } from "../../packages/ai/src/types.ts";
import { TerminalFrameQueue, type TerminalFrameSink } from "../../packages/tui/src/terminal-frame-queue.ts";

export function response(model: Model<Api>, content: AssistantMessage["content"]) {
 const message: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: content.some(c => c.type === "toolCall") ? "toolUse" : "stop", timestamp: 0 };
 const stream = new AssistantMessageEventStream();
 stream.push({type:"done",reason:message.stopReason as "toolUse"|"stop",message});
 return stream;
}

// Real queue; only the physical sink is fake. Explicit completion spans multiple submissions.
class SlowSink implements TerminalFrameSink {
 listener: ((generation: number, error?: Error) => void) | undefined;
 writes = 0;
 last = "";
 generation: number | undefined;
 setFrameWriteCompletionListener(listener: typeof this.listener) { this.listener = listener; }
 writeFrame(data: string, generation: number) {
  this.writes++; this.last = data;
  this.generation = generation;
 }
 release() { const generation=this.generation; this.generation=undefined; if(generation!==undefined) this.listener?.(generation); }
 cancelFrameWrite(_generation: number) { this.generation=undefined; }
}

function gate() {
 let resolve!: () => void;
 const promise=new Promise<void>(done=>{resolve=done;});
 return {promise,resolve};
}

export async function stability(cycles: number) {
 const sink = new SlowSink();
 const queue = new TerminalFrameQueue(sink);
 let toolRound = true, abortRun = false, updates = 0, effects = 0, ended = 0, submissions = 0, observedAborts = 0;
 let started=0;
 let both=gate(), aborted=gate();
 const executions=new Map<string,number>(), aborts=new Set<string>();
 const agent = new Agent({ toolExecution:"parallel", streamFn: (model) => {
  const tools = toolRound; toolRound = false;
  return response(model, tools ? [0,1].map(i => ({type:"toolCall",id:`p-${i}`,name:"progress",arguments:{}})) : [{type:"text",text:"done"}]);
 }});
 agent.state.tools = [{
  name:"progress",label:"progress",description:"offline progress",parameters:{type:"object",properties:{}} as never,
  execute:async (_id, _args, signal, update) => {
   effects++; executions.set(_id,(executions.get(_id)??0)+1);
   if(++started===2) both.resolve();
   await both.promise;
   for(let i=0;i<32;i++) {
    if(signal?.aborted) break;
    update?.({content:[{type:"text",text:String(i)}],details:{i}});
    if(i===0) { if(abortRun) await aborted.promise; else await turn(); }
   }
   if(signal?.aborted) { observedAborts++; aborts.add(_id); }
   return {content:[{type:"text",text:"final"}],details:{}};
  }
 }];
 const delivery=(agent as unknown as {eventDelivery:{criticalListeners:Set<unknown>;observers:Set<unknown>}}).eventDelivery;
 const seen=new Map<string,number>();
 const observe = async (event: import("../../packages/agent/src/types.ts").AgentEvent) => {
  if(event.type==="tool_execution_update") {
   updates++; seen.set(event.toolCallId,event.partialResult.details.i);
   if(abortRun) { agent.abort(); aborted.resolve(); }
  }
  if(event.type==="tool_execution_end" && !abortRun) assert.equal(seen.get(event.toolCallId),31);
  queue.submit(event.type); submissions++;
  if(submissions%3===0) sink.release();
  await turn();
  if(event.type==="agent_end") {
   while(sink.generation!==undefined) { sink.release(); await turn(); }
   await queue.flush(); assert.equal(sink.last,"agent_end"); ended++;
  }
 };
 const observerWeak=new WeakRef(observe);
 const unsub=agent.subscribeObserver(observe,{minIntervalMs:0});
 const critical=agent.subscribe(event => {
  if(event.type==="tool_execution_end" && !abortRun) assert.equal(seen.get(event.toolCallId),31);
 });
 try {
  for(let cycle=0;cycle<cycles;cycle++) {
   for(const abort of [true,false]) {
    abortRun=abort; toolRound=true; seen.clear(); executions.clear(); aborts.clear(); started=0;
    both=gate(); aborted=gate();
    await agent.prompt("fixed workload");
    await agent.waitForIdle(); await queue.flush();
    assert.deepEqual([...executions.entries()].sort(),[["p-0",1],["p-1",1]]);
    assert.deepEqual([...aborts].sort(),abort?["p-0","p-1"]:[]);
    assert.equal(agent.eventDeliveryStats.observerErrors,0);
    assert.equal(agent.state.pendingToolCalls.size,0);
    assert.equal(agent.eventDeliveryStats.pendingKeys,0);
    assert.equal(queue.snapshot().pendingFrames,0); assert.equal(queue.snapshot().activeWrites,0);
    assert.equal(agent.state.isStreaming,false);
   }
  }
  assert.equal(ended,cycles*2);
  assert.equal(observedAborts,cycles*2); assert.equal(effects,cycles*4);
  assert.ok(queue.snapshot().replacedFrames>0,"slow sink must replace pending frames");
  assert.ok(agent.eventDeliveryStats.maxPendingKeys<=2);
  assert.ok(queue.snapshot().frameQueueHighWaterMark<=2);
  const retainedMessages=agent.state.messages.length;
  assert.ok(retainedMessages>0);
  agent.reset(); assert.equal(agent.state.messages.length,0);
  return {weak:[new WeakRef(agent),new WeakRef(queue),observerWeak],metrics:{
   cycles,effects,updates,ended,observedAborts,submissions,writes:sink.writes,retainedMessagesBeforeReset:retainedMessages,
   pendingKeys:agent.eventDeliveryStats.pendingKeys,keyHwm:agent.eventDeliveryStats.maxPendingKeys,
   replacedFrames:queue.snapshot().replacedFrames,observerErrors:agent.eventDeliveryStats.observerErrors,
   frameHwm:queue.snapshot().frameQueueHighWaterMark,pendingFrames:queue.snapshot().pendingFrames,
   listenersAfterUnsubscribe:0
  }};
 } finally {
  unsub(); critical(); assert.equal(delivery.criticalListeners.size,0); assert.equal(delivery.observers.size,0);
  queue.detach(); assert.equal(sink.listener,undefined);
 }
}
