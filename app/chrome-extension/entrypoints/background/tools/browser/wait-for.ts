import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';

type WaitState = 'visible' | 'hidden';

interface WaitForParams {
  selector?: string;
  text?: string;
  state?: WaitState;
  urlIncludes?: string;
  networkIdleMs?: number;
  timeout?: number;
  tabId?: number;
  windowId?: number;
}

interface DomCheck {
  selector?: boolean;
  text?: boolean;
  error?: string;
}

const POLL_INTERVAL_MS = 200;
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 120000;

/**
 * Runs inside the page; must stay self-contained because it is serialized by chrome.scripting.
 */
function checkDom(selector: string | null, text: string | null, state: WaitState): DomCheck {
  const isVisible = (el: Element) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    );
  };
  const result: DomCheck = {};
  if (selector) {
    let elements: Element[];
    try {
      elements = Array.from(document.querySelectorAll(selector));
    } catch {
      return { error: `Invalid selector: ${selector}` };
    }
    const visible = elements.some(isVisible);
    result.selector = state === 'visible' ? visible : !visible;
  }
  if (text) {
    const present = (document.body?.innerText || '').includes(text);
    result.text = state === 'visible' ? present : !present;
  }
  return result;
}

/**
 * Counts in-flight requests of one tab from the moment the wait starts.
 */
class NetworkIdleTracker {
  private readonly inflight = new Set<string>();
  private lastActivity = Date.now();
  private readonly filter: chrome.webRequest.RequestFilter;
  private readonly onStart = (details: { requestId: string }) => {
    this.inflight.add(details.requestId);
    this.lastActivity = Date.now();
  };
  private readonly onEnd = (details: { requestId: string }) => {
    this.inflight.delete(details.requestId);
    this.lastActivity = Date.now();
  };

  constructor(tabId: number) {
    this.filter = { urls: ['<all_urls>'], tabId };
    chrome.webRequest.onBeforeRequest.addListener(this.onStart, this.filter);
    chrome.webRequest.onCompleted.addListener(this.onEnd, this.filter);
    chrome.webRequest.onErrorOccurred.addListener(this.onEnd, this.filter);
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  isIdle(idleMs: number): boolean {
    return this.inflight.size === 0 && Date.now() - this.lastActivity >= idleMs;
  }

  dispose(): void {
    chrome.webRequest.onBeforeRequest.removeListener(this.onStart);
    chrome.webRequest.onCompleted.removeListener(this.onEnd);
    chrome.webRequest.onErrorOccurred.removeListener(this.onEnd);
  }
}

/**
 * Wait until selector / text / URL / network-idle conditions all hold on a tab
 */
class WaitForTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.WAIT_FOR;

  async execute(args: WaitForParams): Promise<ToolResult> {
    const { selector, text, urlIncludes, networkIdleMs, tabId, windowId } = args || {};
    const state: WaitState = args?.state === 'hidden' ? 'hidden' : 'visible';
    const waitNetwork = typeof networkIdleMs === 'number' && networkIdleMs >= 0;
    if (!selector && !text && !urlIncludes && !waitNetwork) {
      return createErrorResponse(
        'Provide at least one of selector, text, urlIncludes or networkIdleMs',
      );
    }
    const timeout = Math.min(
      Math.max(Number(args?.timeout) || DEFAULT_TIMEOUT_MS, 0),
      MAX_TIMEOUT_MS,
    );

    const tab =
      typeof tabId === 'number'
        ? await this.tryGetTab(tabId)
        : await this.getActiveTabInWindow(windowId);
    if (!tab?.id) return createErrorResponse('Target tab not found');
    const targetTabId = tab.id;

    const tracker = waitNetwork ? new NetworkIdleTracker(targetTabId) : null;
    const started = Date.now();
    try {
      for (;;) {
        const conditions: Record<string, boolean> = {};
        const current = await chrome.tabs.get(targetTabId);
        if (urlIncludes) conditions.urlIncludes = (current.url || '').includes(urlIncludes);
        if (selector || text) {
          const dom = await this.checkDomSafely(targetTabId, selector, text, state);
          if (dom.error) return createErrorResponse(dom.error);
          if (selector) conditions.selector = dom.selector === true;
          if (text) conditions.text = dom.text === true;
        }
        if (tracker) conditions.networkIdle = tracker.isIdle(networkIdleMs as number);

        if (Object.values(conditions).every(Boolean)) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  elapsedMs: Date.now() - started,
                  tabId: targetTabId,
                  url: current.url,
                  conditions,
                }),
              },
            ],
            isError: false,
          };
        }
        if (Date.now() - started >= timeout) {
          const unmet = Object.keys(conditions).filter((key) => !conditions[key]);
          const inflight = tracker ? ` (in-flight requests: ${tracker.inflightCount})` : '';
          return createErrorResponse(
            `Timed out after ${timeout}ms waiting for: ${unmet.join(', ')}${inflight}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } catch (error) {
      return createErrorResponse(
        `Wait failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      tracker?.dispose();
    }
  }

  /**
   * Treats script-injection failures (e.g. page mid-navigation) as "not yet satisfied".
   */
  private async checkDomSafely(
    tabId: number,
    selector: string | undefined,
    text: string | undefined,
    state: WaitState,
  ): Promise<DomCheck> {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: checkDom,
        args: [selector ?? null, text ?? null, state],
      });
      return (res?.result as DomCheck) ?? {};
    } catch {
      return {};
    }
  }
}

export const waitForTool = new WaitForTool();
