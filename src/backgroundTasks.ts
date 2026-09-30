import { EventEmitter } from 'node:events';
import { ChatSession } from './session.js';
import { SessionSync } from './sessionSync.js';
import type { McpManager } from './mcp/manager.js';
import type { PermissionMode } from './permissions.js';

/** One `/background` task: a prompt running in a copy of the conversation. */
export interface BackgroundTask {
  id: number;
  prompt: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  startedAt: Date;
  finishedAt?: Date;
  result?: string;
  /** Actions the permission mode wanted a human for; nobody can answer in the background, so they were refused. */
  denied: string[];
  session: ChatSession;
}

/**
 * `/background` and `/tasks`: prompts that run in a copy of the current
 * conversation while the chat stays usable. Nobody can answer an Allow/Deny
 * question in the background, so what the permission mode would ask about is
 * refused (as in `aiolah -p`). Emits `finished` with the task.
 */
export class BackgroundTasks extends EventEmitter {
  private readonly tasks: BackgroundTask[] = [];
  private nextId = 1;

  start(source: ChatSession, prompt: string, options: { mode: PermissionMode; mcp?: McpManager }): BackgroundTask {
    const denied: string[] = [];
    const session = this.copyOf(source, options, denied);
    const task: BackgroundTask = {
      id: this.nextId++,
      prompt,
      status: 'running',
      startedAt: new Date(),
      denied,
      session,
    };
    this.tasks.push(task);
    SessionSync.attach(session, { origin: 'script' });
    void session.send(prompt, 'script').then(
      ({ reply }) => this.finish(task, 'done', reply),
      (error: unknown) =>
        this.finish(
          task,
          task.status === 'stopped' ? 'stopped' : 'failed',
          error instanceof Error ? error.message : String(error),
        ),
    );
    return task;
  }

  list(): BackgroundTask[] {
    return [...this.tasks];
  }

  get(id: number): BackgroundTask | undefined {
    return this.tasks.find((task) => task.id === id);
  }

  stop(id: number): boolean {
    const task = this.get(id);
    if (!task || task.status !== 'running') {
      return false;
    }
    task.status = 'stopped';
    task.session.interrupt();
    return true;
  }

  get running(): number {
    return this.tasks.filter((task) => task.status === 'running').length;
  }

  /** A new session with the source's history, provider, model, directories and MCP servers. */
  private copyOf(
    source: ChatSession,
    options: { mode: PermissionMode; mcp?: McpManager },
    denied: string[],
  ): ChatSession {
    const create = (resumeId?: string) =>
      new ChatSession({
        provider: source.providerId,
        model: source.modelId,
        workspaceRoot: source.workspace,
        permissionMode: options.mode,
        confirm: async (description) => {
          denied.push(description);
          return false;
        },
        resumeId,
        mcp: options.mcp,
      });
    let session: ChatSession;
    try {
      // The conversation is saved after every step, so the copy starts from the same history.
      session = create(source.renderHistory().length ? source.sessionId : undefined);
      session.fork();
    } catch {
      session = create();
    }
    for (const dir of source.additionalDirectories) {
      session.addDir(dir);
    }
    return session;
  }

  private finish(task: BackgroundTask, status: BackgroundTask['status'], result: string): void {
    task.status = status;
    task.result = result;
    task.finishedAt = new Date();
    this.emit('finished', task);
  }
}
