// AGE-17 spike: one Agent SDK query() per run, logging auth source, session id
// and the transcript files on the volume. Never prints a credential.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const CREDENTIAL_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

function printEnv() {
  for (const name of CREDENTIAL_VARS) {
    console.log(`${name}: ${process.env[name] ? 'set' : 'unset'}`);
  }
}

// Every transcript under $CLAUDE_CONFIG_DIR/projects, with line count and mtime.
function transcripts() {
  const root = join(process.env.CLAUDE_CONFIG_DIR ?? '', 'projects');
  const found = [];
  let dirs = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return found;
  }
  for (const dir of dirs) {
    for (const file of readdirSync(join(root, dir))) {
      if (!file.endsWith('.jsonl')) continue;
      const path = join(root, dir, file);
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      found.push({
        path: `projects/${dir}/${file}`,
        lines: lines.length,
        mtime: statSync(path).mtime.toISOString(),
      });
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

function printTranscripts(label) {
  console.log(`--- transcripts ${label}`);
  const list = transcripts();
  if (list.length === 0) console.log('(none)');
  for (const t of list) console.log(`${t.path}  lines=${t.lines}  mtime=${t.mtime}`);
}

async function run(prompt, values) {
  const options = {
    tools: [],
    maxTurns: 1,
    settingSources: [],
    persistSession: true,
    stderr: (line) => process.stderr.write(`[cli] ${line}`),
  };
  if (values['session-id']) options.sessionId = values['session-id'];
  if (values.resume) options.resume = values.resume;
  if (values.fork) options.forkSession = true;
  console.log('options:', JSON.stringify({
    sessionId: options.sessionId,
    resume: options.resume,
    forkSession: options.forkSession,
  }));
  printEnv();
  printTranscripts('before');

  try {
    for await (const message of query({ prompt, options })) {
      if (message.type === 'system' && message.subtype === 'init') {
        console.log('init:', JSON.stringify({
          apiKeySource: message.apiKeySource,
          model: message.model,
          claude_code_version: message.claude_code_version,
          session_id: message.session_id,
          cwd: message.cwd,
        }));
      } else if (message.type === 'assistant') {
        const text = message.message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
        if (text) console.log(`assistant: ${text}`);
      } else if (message.type === 'result') {
        console.log('result:', JSON.stringify({
          subtype: message.subtype,
          is_error: message.is_error,
          session_id: message.session_id,
          num_turns: message.num_turns,
          errors: message.errors,
          result: message.result,
        }));
      }
    }
  } catch (error) {
    console.log(`threw: ${error.message}`);
  }
  printTranscripts('after');
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'session-id': { type: 'string' },
    resume: { type: 'string' },
    fork: { type: 'boolean' },
  },
});

const [command, ...rest] = positionals;
if (command === 'env') {
  printEnv();
} else if (command === 'transcripts') {
  printTranscripts('now');
} else if (command === 'ask') {
  await run(rest.join(' '), values);
} else {
  console.error('usage: spike.mjs env | transcripts | ask [--session-id ID] [--resume ID] [--fork] <prompt>');
  process.exit(2);
}
