// Compare Bedrock models on the real production payload (system prompt + 9 tool schemas).
//   node scripts/bench-models.mjs [modelId ...]
// Reports latency and whether the model made the right first-step tool calls.
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { writeFileSync } from 'node:fs';
import { config } from '../server/config.js';
import { seed } from '../server/seed.js';
import { createStore, createSession } from '../server/store.js';
import { buildSystem } from '../server/agent.js';
import { toolSpecs } from '../server/tools/index.js';

const models = process.argv.slice(2).length ? process.argv.slice(2) : [
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'us.amazon.nova-pro-v1:0',
  'us.amazon.nova-lite-v1:0',
];
const client = new BedrockRuntimeClient({ region: config.region });
const store = createStore(seed);
const session = createSession(store, {});
const system = [{ text: buildSystem(store, session) }];
const prompts = [
  'Hi, my insulin is getting warm because the power is out and I have no car.',
  'We have no food. Family of four, and we have no car.',
  'Is the cooling center on 10th Street open right now?',
];

const lines = [];
const out = (s) => { console.log(s); lines.push(s); };
for (const modelId of models) {
  out(`\n${modelId}  (pass 1 = cold, pass 2 = warm)`);
  for (const text of [...prompts, ...prompts]) {
    const t0 = Date.now();
    try {
      const res = await client.send(new ConverseCommand({
        modelId, system, toolConfig: { tools: toolSpecs },
        messages: [{ role: 'user', content: [{ text }] }],
        inferenceConfig: { maxTokens: 500, temperature: 0.2 },
      }));
      const uses = (res.output.message.content.filter((c) => c.toolUse)).map((c) => c.toolUse.name);
      out(`  ${String(Date.now() - t0).padStart(5)} ms  in=${res.usage.inputTokens} out=${res.usage.outputTokens}  tools=[${uses.join(', ')}]  "${text.slice(0, 40)}"`);
    } catch (err) {
      out(`  FAILED ${err.name}: ${err.message.slice(0, 100)}  "${text.slice(0, 40)}"`);
    }
  }
}
writeFileSync('/tmp/ll_bench.txt', lines.join('\n') + '\nDONE\n');
