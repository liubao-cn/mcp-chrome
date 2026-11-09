import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

interface HandleDialogParams {
  action: 'accept' | 'dismiss';
  promptText?: string;
  arm?: boolean;
  timeoutMs?: number;
  tabId?: number;
}

const DEFAULT_ARM_TIMEOUT_MS = 30000;
const MAX_ARM_TIMEOUT_MS = 120000;

/**
 * Handle JavaScript dialogs (alert/confirm/prompt) via CDP Page.handleJavaScriptDialog
 */
class HandleDialogTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.HANDLE_DIALOG;

  async execute(args: HandleDialogParams): Promise<ToolResult> {
    const { action, promptText } = args || ({} as HandleDialogParams);
    if (!action || (action !== 'accept' && action !== 'dismiss')) {
      return createErrorResponse('action must be "accept" or "dismiss"');
    }

    try {
      const tab =
        (await this.tryGetTab(args?.tabId)) ||
        (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab?.id) return createErrorResponse('No active tab found');
      const tabId = tab.id;

      if (args?.arm) {
        const timeoutMs = Math.min(
          Math.max(Number(args.timeoutMs) || DEFAULT_ARM_TIMEOUT_MS, 1000),
          MAX_ARM_TIMEOUT_MS,
        );
        await this.armForNextDialog(tabId, action, promptText, timeoutMs);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, armed: true, action, tabId, timeoutMs }),
            },
          ],
          isError: false,
        };
      }

      // Use shared CDP session manager for safe attach/detach with refcount
      await cdpSessionManager.withSession(tabId, 'dialog', async () => {
        await cdpSessionManager.sendCommand(tabId, 'Page.enable');
        await cdpSessionManager.sendCommand(tabId, 'Page.handleJavaScriptDialog', {
          accept: action === 'accept',
          promptText: action === 'accept' ? promptText : undefined,
        });
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, action, promptText: promptText || null }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = message.includes('No dialog is showing')
        ? ' Dialogs opened before the debugger attached cannot be handled; call this tool with arm=true before the action that opens the dialog.'
        : '';
      return createErrorResponse(`Failed to handle dialog: ${message}${hint}`);
    }
  }

  /**
   * Keep a Page-enabled CDP session on the tab and answer the next dialog it opens.
   */
  private async armForNextDialog(
    tabId: number,
    action: 'accept' | 'dismiss',
    promptText: string | undefined,
    timeoutMs: number,
  ): Promise<void> {
    await cdpSessionManager.attach(tabId, 'dialog-arm');
    await cdpSessionManager.sendCommand(tabId, 'Page.enable');
    const release = () => {
      chrome.debugger.onEvent.removeListener(onEvent);
      clearTimeout(timer);
      cdpSessionManager.detach(tabId, 'dialog-arm').catch(() => {});
    };
    const onEvent = (source: chrome.debugger.Debuggee, method: string) => {
      if (source.tabId !== tabId || method !== 'Page.javascriptDialogOpening') return;
      cdpSessionManager
        .sendCommand(tabId, 'Page.handleJavaScriptDialog', {
          accept: action === 'accept',
          promptText: action === 'accept' ? promptText : undefined,
        })
        .catch(() => {})
        .finally(release);
    };
    chrome.debugger.onEvent.addListener(onEvent);
    const timer = setTimeout(release, timeoutMs);
  }
}

export const handleDialogTool = new HandleDialogTool();
