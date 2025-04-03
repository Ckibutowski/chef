import type { WebContainer } from '@webcontainer/api';
import { path as nodePath } from '~/utils/path';
import { atom, map, type MapStore } from 'nanostores';
import type { ActionAlert, BoltAction, FileHistory } from '~/types/actions';
import { createScopedLogger } from '~/utils/logger';
import { unreachable } from '~/utils/unreachable';
import type { ActionCallbackData } from './message-parser';
import type { BoltShell } from '~/utils/shell';
import type { ToolInvocation } from 'ai';
import { withResolvers } from '~/utils/promises';
import { BackupStack, editor, editorToolParameters } from './editorTool';
import { bashToolParameters } from './bashTool';

const logger = createScopedLogger('ActionRunner');

export type ActionStatus = 'pending' | 'running' | 'complete' | 'aborted' | 'failed';

export type BaseActionState = BoltAction & {
  status: Exclude<ActionStatus, 'failed'>;
  abort: () => void;
  executed: boolean;
  abortSignal: AbortSignal;
};

export type FailedActionState = BoltAction &
  Omit<BaseActionState, 'status'> & {
    status: Extract<ActionStatus, 'failed'>;
    error: string;
  };

export type ActionState = BaseActionState | FailedActionState;

type BaseActionUpdate = Partial<Pick<BaseActionState, 'status' | 'abort' | 'executed' | 'content'>>;

export type ActionStateUpdate =
  | BaseActionUpdate
  | (Omit<BaseActionUpdate, 'status'> & { status: 'failed'; error: string })
  | Pick<BaseActionState & { type: 'convex' }, 'output'>;

type ActionsMap = MapStore<Record<string, ActionState>>;

class ActionCommandError extends Error {
  readonly _output: string;
  readonly _header: string;

  constructor(message: string, output: string) {
    // Create a formatted message that includes both the error message and output
    const formattedMessage = `Failed To Execute Shell Command: ${message}\n\nOutput:\n${output}`;
    super(formattedMessage);

    // Set the output separately so it can be accessed programmatically
    this._header = message;
    this._output = output;

    // Maintain proper prototype chain
    Object.setPrototypeOf(this, ActionCommandError.prototype);

    // Set the name of the error for better debugging
    this.name = 'ActionCommandError';
  }

  // Optional: Add a method to get just the terminal output
  get output() {
    return this._output;
  }
  get header() {
    return this._header;
  }
}

export class ActionRunner {
  #webcontainer: Promise<WebContainer>;
  #currentExecutionPromise: Promise<void> = Promise.resolve();
  #shellTerminal: () => BoltShell;
  runnerId = atom<string>(`${Date.now()}`);
  actions: ActionsMap = map({});
  onAlert?: (alert: ActionAlert) => void;
  buildOutput?: { path: string; exitCode: number; output: string };

  constructor(
    private toolCalls: Map<string, PromiseWithResolvers<string>>,
    private backupStack: BackupStack,
    webcontainerPromise: Promise<WebContainer>,
    getShellTerminal: () => BoltShell,
    onAlert?: (alert: ActionAlert) => void,
  ) {
    this.#webcontainer = webcontainerPromise;
    this.#shellTerminal = getShellTerminal;
    this.onAlert = onAlert;
  }

  addAction(data: ActionCallbackData) {
    const { actionId } = data;

    const actions = this.actions.get();
    const action = actions[actionId];

    if (action) {
      if (action.content !== data.action.content) {
        this.updateAction(actionId, { ...action, content: data.action.content });
      }
      return;
    }

    const abortController = new AbortController();

    this.actions.setKey(actionId, {
      ...data.action,
      status: 'pending',
      executed: false,
      abort: () => {
        abortController.abort();
        this.updateAction(actionId, { status: 'aborted' });
      },
      abortSignal: abortController.signal,
    });

    this.#currentExecutionPromise.then(() => {
      this.updateAction(actionId, { status: 'running' });
    });
  }

  async runAction(data: ActionCallbackData, isStreaming: boolean = false) {
    console.log('runAction', data);
    const { actionId } = data;
    const action = this.actions.get()[actionId];

    if (!action) {
      unreachable(`Action ${actionId} not found`);
    }

    if (action.executed) {
      return; // No return value here
    }

    if (isStreaming && action.type !== 'file') {
      return; // No return value here
    }

    this.updateAction(actionId, { ...action, ...data.action, executed: !isStreaming });

    this.#currentExecutionPromise = this.#currentExecutionPromise
      .then(() => {
        return this.#executeAction(actionId, isStreaming);
      })
      .catch((error) => {
        console.error('Action failed:', error);
      });

    await this.#currentExecutionPromise;

    return;
  }

  async #executeAction(actionId: string, isStreaming: boolean = false) {
    const action = this.actions.get()[actionId];

    this.updateAction(actionId, { status: 'running' });

    try {
      switch (action.type) {
        case 'shell': {
          logger.error('Convex action is not supported anymore. Use tool calls instead.');
          await this.#runShellAction(action);
          break;
        }
        case 'npmInstall': {
          await this.#runNpmInstallAction(action);
          break;
        }
        case 'npmExec': {
          await this.#runNpmExecAction(action);
          break;
        }
        case 'file': {
          await this.#runFileAction(action);
          break;
        }
        case 'build': {
          const buildOutput = await this.#runBuildAction(action);

          // Store build output for deployment
          this.buildOutput = buildOutput;
          break;
        }
        case 'start': {
          // making the start app non blocking

          this.#runStartAction(action)
            .then(() => this.updateAction(actionId, { status: 'complete' }))
            .catch((err: Error) => {
              if (action.abortSignal.aborted) {
                return;
              }

              this.updateAction(actionId, { status: 'failed', error: 'Action failed' });
              logger.error(`[${action.type}]:Action failed\n\n`, err);

              if (!(err instanceof ActionCommandError)) {
                return;
              }

              this.onAlert?.({
                type: 'error',
                title: 'Dev Server Failed',
                description: err.header,
                content: err.output,
              });
            });

          /*
           * adding a delay to avoid any race condition between 2 start actions
           * i am up for a better approach
           */
          await new Promise((resolve) => setTimeout(resolve, 2000));

          return;
        }
        case 'convex': {
          logger.error('Convex action is not supported anymore. Use tool calls instead.');
          break;
        }
        case 'toolUse': {
          await this.#runToolUseAction(actionId, action);
          break;
        }
      }

      this.updateAction(actionId, {
        status: isStreaming ? 'running' : action.abortSignal.aborted ? 'aborted' : 'complete',
      });
    } catch (error) {
      if (action.abortSignal.aborted) {
        return;
      }

      this.updateAction(actionId, { status: 'failed', error: 'Action failed' });
      logger.error(`[${action.type}]:Action failed\n\n`, error);

      if (!(error instanceof ActionCommandError)) {
        return;
      }

      this.onAlert?.({
        type: 'error',
        title: 'Dev Server Failed',
        description: error.header,
        content: error.output,
      });

      // re-throw the error to be caught in the promise chain
      throw error;
    }
  }

  async #runShellAction(action: ActionState) {
    if (action.type !== 'shell') {
      unreachable('Expected shell action');
    }
    logger.debug(`[${action.type}]:Running Shell Action\n\n`, action);

    const shell = this.#shellTerminal();
    await shell.ready();

    if (!shell || !shell.terminal || !shell.process) {
      unreachable('Shell terminal not found');
    }

    const resp = await shell.executeCommand(this.runnerId.get(), action.content, () => {
      logger.debug(`[${action.type}]:Aborting Action\n\n`, action);
      action.abort();
    });
    logger.debug(`${action.type} Shell Response: [exit code:${resp?.exitCode}]`);

    if (resp?.exitCode != 0) {
      throw new ActionCommandError(`Failed To Execute Shell Command`, resp?.output || 'No Output Available');
    }
  }

  async #runNpmInstallAction(action: ActionState) {
    if (action.type !== 'npmInstall') {
      unreachable('Expected npmInstall action');
    }
    const normalizedCommand = action.content.startsWith('npm install')
      ? action.content.slice('npm install'.length)
      : action.content.startsWith('npm i')
        ? action.content.slice('npm i'.length)
        : action.content;
    if (normalizedCommand.match(/\bconvex\b/)) {
      logger.error('Convex is already installed');
      return;
    }
    await this.#runShellAction({
      ...action,
      type: 'shell',
      content: `npm install ${normalizedCommand}`,
    });
  }

  async #runNpmExecAction(action: ActionState) {
    if (action.type !== 'npmExec') {
      unreachable('Expected npmExec action');
    }
    if (!action.content.startsWith('npm run ') && !action.content.startsWith('npx ')) {
      logger.error(`Invalid npmExec action: ${action.content}`);
      return;
    }
    if (action.content.match(/\bconvex\b/)) {
      logger.error('Convex should be run as a tool call');
      return;
    }
    if (action.content === 'npm run dev') {
      logger.error('Dev server should be run as a tool call');
      return;
    }
    await this.#runShellAction({
      ...action,
      type: 'shell',
      content: action.content,
    });
  }

  async #runStartAction(action: ActionState) {
    if (action.type !== 'start') {
      unreachable('Expected shell action');
    }

    if (!this.#shellTerminal) {
      unreachable('Shell terminal not found');
    }

    const shell = this.#shellTerminal();
    await shell.ready();

    if (!shell || !shell.terminal || !shell.process) {
      unreachable('Shell terminal not found');
    }

    const resp = await shell.executeCommand(this.runnerId.get(), action.content, () => {
      logger.debug(`[${action.type}]:Aborting Action\n\n`, action);
      action.abort();
    });
    logger.debug(`${action.type} Shell Response: [exit code:${resp?.exitCode}]`);

    if (resp?.exitCode != 0) {
      throw new ActionCommandError('Failed To Start Application', resp?.output || 'No Output Available');
    }

    return resp;
  }

  async #runFileAction(action: ActionState) {
    if (action.type !== 'file') {
      unreachable('Expected file action');
    }

    const webcontainer = await this.#webcontainer;
    const relativePath = nodePath.relative(webcontainer.workdir, action.filePath);

    let folder = nodePath.dirname(relativePath);

    // remove trailing slashes
    folder = folder.replace(/\/+$/g, '');

    if (folder !== '.') {
      try {
        await webcontainer.fs.mkdir(folder, { recursive: true });
        logger.debug('Created folder', folder);
      } catch (error) {
        logger.error('Failed to create folder\n\n', error);
      }
    }

    try {
      await webcontainer.fs.writeFile(relativePath, action.content);
      logger.debug(`File written ${relativePath}`);
    } catch (error) {
      logger.error('Failed to write file\n\n', error);
    }
  }

  updateAction(id: string, newState: ActionStateUpdate) {
    const actions = this.actions.get();

    this.actions.setKey(id, { ...actions[id], ...newState });
  }

  async getFileHistory(filePath: string): Promise<FileHistory | null> {
    try {
      const webcontainer = await this.#webcontainer;
      const historyPath = this.#getHistoryPath(filePath);
      const content = await webcontainer.fs.readFile(historyPath, 'utf-8');

      return JSON.parse(content);
    } catch (error) {
      logger.error('Failed to get file history:', error);
      return null;
    }
  }

  async saveFileHistory(filePath: string, history: FileHistory) {
    // const webcontainer = await this.#webcontainer;
    const historyPath = this.#getHistoryPath(filePath);

    await this.#runFileAction({
      type: 'file',
      filePath: historyPath,
      content: JSON.stringify(history),
      changeSource: 'auto-save',
    } as any);
  }

  #getHistoryPath(filePath: string) {
    return nodePath.join('.history', filePath);
  }

  async #runBuildAction(action: ActionState) {
    if (action.type !== 'build') {
      unreachable('Expected build action');
    }

    const webcontainer = await this.#webcontainer;

    // Create a new terminal specifically for the build
    const buildProcess = await webcontainer.spawn('npm', ['run', 'build']);

    let output = '';
    buildProcess.output.pipeTo(
      new WritableStream({
        write(data) {
          output += data;
        },
      }),
    );

    const exitCode = await buildProcess.exit;

    if (exitCode !== 0) {
      throw new ActionCommandError('Build Failed', output || 'No Output Available');
    }

    // Get the build output directory path
    const buildDir = nodePath.join(webcontainer.workdir, 'dist');

    return {
      path: buildDir,
      exitCode,
      output,
    };
  }

  async #runToolUseAction(actionId: string, action: ActionState) {
    const parsed: ToolInvocation = JSON.parse(action.content);
    if (parsed.state === 'result') {
      return;
    }
    if (parsed.state === 'partial-call') {
      throw new Error('Tool call is still in progress');
    }

    let resolvers = this.toolCalls.get(parsed.toolCallId);
    if (!resolvers) {
      resolvers = withResolvers<string>();
      this.toolCalls.set(parsed.toolCallId, resolvers);
    }
    let result: string;
    try {
      switch (parsed.toolName) {
        case 'str_replace_editor': {
          const args = editorToolParameters.parse(parsed.args);
          const container = await this.#webcontainer;
          result = await editor(container, args, this.backupStack);
          break;
        }
        case 'bash': {
          const args = bashToolParameters.parse(parsed.args);
          if (!args.command.length) {
            throw new Error('A nonempty command is required');
          }
          const shell = this.#shellTerminal();
          await shell.ready();
          const resp = await shell.executeCommand(this.runnerId.get(), args.command, () => {
            logger.debug(`[${action.type}]:Aborting Action\n\n`, action);
            action.abort();
          });
          logger.debug(`${action.type} Shell Response: [exit code:${resp?.exitCode}]`);
          if (resp?.exitCode !== 0) {
            throw new Error(`Process exited with code ${resp?.exitCode}: ${resp?.output}`);
          } else {
            result = resp?.output || '';
          }
          break;
        }
        case 'deploy': {
          result = await this._runShellCommand(`npx convex dev --once`, () => {
            logger.debug(`[${action.type}]:Aborting Action\n\n`, action);
            action.abort();
          });
          // Check if the dev server (vite) is already running on port 5173
          // const devServerRunning = await this._runShellCommand(`netstat -an | grep 5173`, () => {
          //   logger.debug(`[${action.type}]:Aborting Action\n\n`, action);
          //   action.abort();
          // });
          // if (!devServerRunning.includes('LISTEN')) {
          //   // Start the dev server
          //   result += await this._runShellCommand(`npx vite`, () => {
          //     logger.debug(`[${action.type}]:Aborting Action\n\n`, action);
          //     action.abort();
          //   });
          // } else {
          //   logger.info('Vite dev server is already running');
          // }
          break;
        }

        default: {
          throw new Error(`Unknown tool: ${parsed.toolName}`);
        }
      }
      resolvers.resolve(result);
    } catch (e: any) {
      console.error('Error on tool call', e);
      let message = e.toString();
      if (!message.startsWith('Error:')) {
        message = 'Error: ' + message;
      }
      resolvers.resolve(message);
      throw e;
    }
  }

  async _runShellCommand(command: string, onAbort: () => void) {
    const shell = this.#shellTerminal();
    await shell.ready();
    const resp = await shell.executeCommand(this.runnerId.get(), command, () => {
      onAbort();
    });
    if (resp?.exitCode !== 0) {
      throw new Error(`Process exited with code ${resp?.exitCode}: ${cleanConvexOutput(command, resp?.output || '')}`);
    }
    return resp?.output || '';
  }
}

const BANNED_LINES = [
  'Preparing Convex functions...',
  'Checking that documents match your schema...',
  'transforming (',
  'computing gzip size',
];

// Cleaning terminal output helps the agent focus on the important parts and
// not waste input tokens.
function cleanConvexOutput(command: string, output: string) {
  if (command !== 'npm run lint') {
    return output;
  }
  const normalizedNewlines = output.replace('\r\n', '\n').replace('\r', '\n');
  const result = normalizedNewlines
    // Remove lines that include "Preparing Convex functions..."
    .split('\n')
    .filter((line) => !BANNED_LINES.some((bannedLine) => line.includes(bannedLine)))
    .join('\n');
  if (output !== result) {
    console.log(`Sanitized output of ${command}: ${output.length} -> ${result.length}`);
  }
  return result;
}
