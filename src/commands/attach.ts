import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import WebSocket from 'ws';
import { signChallenge } from '../auth.js';
import { ask } from '../prompt.js';
import type { HistoryItem, WireMessage } from '../protocol.js';

const RESULT_PREVIEW_CHARS = 300;

export async function attachCommand(address: string): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const token = process.env.AIOLAH_REMOTE_TOKEN || (await rl.question('Remote token: '));

  const socket = new WebSocket(address);
  const pendingConfirms: string[] = [];
  /** Whether this turn's answer is being printed as it is written (hosts on 0.1.4+). */
  let streaming = false;

  await new Promise<void>((resolveOpen, reject) => {
    socket.once('open', resolveOpen);
    socket.once('error', reject);
  });

  const authed = new Promise<void>((resolveAuthed, reject) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as WireMessage;

      switch (message.type) {
        case 'challenge':
          send(socket, { type: 'auth', hmac: signChallenge(token, message.nonce) });
          return;
        case 'authed':
          stdout.write(`session ${message.sessionId} — model ${message.model}, workspace ${message.workspace}\n`);
          for (const item of message.history) {
            renderHistoryItem(item);
          }
          resolveAuthed();
          return;
        case 'error':
          if (message.text === 'unauthorized' || message.text === 'rate limited') {
            reject(new Error(message.text));
          } else {
            stdout.write(`\n[error] ${message.text}\n`);
          }
          return;
        case 'user':
          stdout.write(`\nother> ${message.text}\n`);
          return;
        case 'assistant_delta':
          stdout.write(`${streaming ? '' : '\nassistant> '}${message.text}`);
          streaming = true;
          return;
        case 'assistant':
          stdout.write(streaming ? '\n\n' : `\nassistant> ${message.text}\n\n`);
          streaming = false;
          return;
        case 'tool':
          stdout.write(`${streaming ? '\n' : ''}\n[tool] ${message.name} ${JSON.stringify(message.input)}\n`);
          streaming = false;
          return;
        case 'tool_result':
          stdout.write(`[tool_result] ${message.name}: ${preview(message.result)}\n`);
          return;
        case 'confirm':
          pendingConfirms.push(message.id);
          stdout.write(`\n[confirm] Allow ${message.description}? Type y or n.\n`);
          return;
        case 'busy':
          stdout.write('[working…]\n');
          return;
        case 'idle':
        case 'auth':
        case 'confirm_reply':
          return;
      }
    });
  });

  await authed;
  stdout.write(`aiolah attach — connected to ${address}. Type "exit" to quit.\n\n`);

  try {
    while (true) {
      const input = await ask(rl, 'you> ');
      if (input === null || input.trim().toLowerCase() === 'exit') {
        break;
      }
      const trimmed = input.trim();
      if (!trimmed) {
        continue;
      }
      if (pendingConfirms.length > 0 && /^[yn]$/i.test(trimmed)) {
        const id = pendingConfirms.shift() as string;
        send(socket, { type: 'confirm_reply', id, allow: trimmed.toLowerCase() === 'y' });
        continue;
      }
      send(socket, { type: 'user', text: input });
    }
  } finally {
    rl.close();
    socket.close();
  }
}

function renderHistoryItem(item: HistoryItem): void {
  if (item.role === 'user') {
    stdout.write(`you> ${item.text}\n`);
  } else if (item.role === 'assistant') {
    stdout.write(`assistant> ${item.text}\n\n`);
  } else {
    stdout.write(`[tool] ${item.name} ${JSON.stringify(item.input)} → ${preview(item.result)}\n`);
  }
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > RESULT_PREVIEW_CHARS ? `${flat.slice(0, RESULT_PREVIEW_CHARS)}…` : flat;
}

function send(socket: WebSocket, message: WireMessage): void {
  socket.send(JSON.stringify(message));
}
