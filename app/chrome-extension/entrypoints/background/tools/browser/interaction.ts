import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
import { CDPHelper } from './cdp-input';

interface Coordinates {
  x: number;
  y: number;
}

/**
 * Runs in the extension's isolated world (where read_page refs live): scroll the target into
 * view and return its centre, or null when it is missing, invisible or covered by another element.
 */
function locateClickPoint(selector: string | null, ref: string | null): Coordinates | null {
  let el: Element | null = null;
  if (ref) {
    const entry = (window as any).__claudeElementMap?.[ref];
    el = entry?.deref ? entry.deref() : null;
  } else if (selector) {
    el = document.querySelector(selector);
  }
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(x, y);
  return hit && (hit === el || el.contains(hit)) ? { x, y } : null;
}

interface ClickToolParams {
  selector?: string; // CSS selector or XPath for the element to click
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  ref?: string; // Element ref from accessibility tree (window.__claudeElementMap)
  coordinates?: Coordinates; // Coordinates to click at (x, y relative to viewport)
  waitForNavigation?: boolean; // Whether to wait for navigation to complete after click
  timeout?: number; // Timeout in milliseconds for waiting for the element or navigation
  frameId?: number; // Target frame for ref/selector resolution
  double?: boolean; // Perform double click when true
  button?: 'left' | 'right' | 'middle';
  bubbles?: boolean;
  cancelable?: boolean;
  modifiers?: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  trusted?: boolean; // real input via CDP (default true); false forces synthetic DOM events
}

/**
 * Tool for clicking elements on web pages
 */
class ClickTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLICK;

  /**
   * Execute click operation
   */
  async execute(args: ClickToolParams): Promise<ToolResult> {
    const {
      selector,
      selectorType = 'css',
      coordinates,
      waitForNavigation = false,
      timeout = TIMEOUTS.DEFAULT_WAIT * 5,
      frameId,
      button,
      bubbles,
      cancelable,
      modifiers,
    } = args;

    console.log(`Starting click operation with options:`, args);

    if (!selector && !coordinates && !args.ref) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS + ': Provide ref or selector or coordinates',
      );
    }

    try {
      // Resolve tab
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      let finalRef = args.ref;
      let finalSelector = selector;

      // If selector is XPath, convert to ref first
      if (selector && selectorType === 'xpath') {
        await this.injectContentScript(tab.id, ['inject-scripts/accessibility-tree-helper.js']);
        try {
          const resolved = await this.sendMessageToTab(
            tab.id,
            {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector,
              isXPath: true,
            },
            frameId,
          );
          if (resolved && resolved.success && resolved.ref) {
            finalRef = resolved.ref;
            finalSelector = undefined; // Use ref instead of selector
          } else {
            return createErrorResponse(
              `Failed to resolve XPath selector: ${resolved?.error || 'unknown error'}`,
            );
          }
        } catch (error) {
          return createErrorResponse(
            `Error resolving XPath: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (args.trusted !== false && !frameId) {
        const trustedResult = await this.tryTrustedClick(tab.id, {
          selector: finalSelector,
          ref: finalRef,
          coordinates,
          double: args.double === true,
          button,
          modifiers,
          waitForNavigation,
          timeout,
        });
        if (trustedResult) return trustedResult;
      }

      await this.injectContentScript(tab.id, ['inject-scripts/click-helper.js']);

      // Send click message to content script
      const result = await this.sendMessageToTab(
        tab.id,
        {
          action: TOOL_MESSAGE_TYPES.CLICK_ELEMENT,
          selector: finalSelector,
          coordinates,
          ref: finalRef,
          waitForNavigation,
          timeout,
          double: args.double === true,
          button,
          bubbles,
          cancelable,
          modifiers,
        },
        frameId,
      );

      // Determine actual click method used
      let clickMethod: string;
      if (coordinates) {
        clickMethod = 'coordinates';
      } else if (finalRef) {
        clickMethod = 'ref';
      } else if (finalSelector) {
        clickMethod = 'selector';
      } else {
        clickMethod = 'unknown';
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: result.message || 'Click operation successful',
              elementInfo: result.elementInfo,
              navigationOccurred: result.navigationOccurred,
              clickMethod,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in click operation:', error);
      return createErrorResponse(
        `Error performing click: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Click through CDP mouse events so the page sees a real user gesture: downloads are not
   * treated as automatic, popups are not blocked and activation-gated APIs work.
   * Returns null when the target cannot be hit directly, so the caller falls back to DOM events.
   */
  private async tryTrustedClick(
    tabId: number,
    opts: {
      selector?: string;
      ref?: string;
      coordinates?: Coordinates;
      double: boolean;
      button?: 'left' | 'right' | 'middle';
      modifiers?: ClickToolParams['modifiers'];
      waitForNavigation: boolean;
      timeout: number;
    },
  ): Promise<ToolResult | null> {
    let point = opts.coordinates ?? null;
    if (!point) {
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          func: locateClickPoint,
          args: [opts.selector ?? null, opts.ref ?? null],
        });
        point = (res?.result as Coordinates | null) ?? null;
      } catch {
        return null;
      }
    }
    if (!point) return null;

    try {
      await CDPHelper.attach(tabId);
    } catch {
      return null;
    }
    const button = opts.button || 'left';
    const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
    const m = opts.modifiers || {};
    const modifiers =
      (m.altKey ? 1 : 0) | (m.ctrlKey ? 2 : 0) | (m.metaKey ? 4 : 0) | (m.shiftKey ? 8 : 0);
    const { x, y } = point;
    const urlBefore = (await chrome.tabs.get(tabId)).url;
    try {
      await CDPHelper.dispatchMouseEvent(tabId, { type: 'mouseMoved', x, y, modifiers });
      for (let clickCount = 1; clickCount <= (opts.double ? 2 : 1); clickCount++) {
        await CDPHelper.dispatchMouseEvent(tabId, {
          type: 'mousePressed',
          x,
          y,
          button,
          buttons,
          clickCount,
          modifiers,
        });
        await CDPHelper.dispatchMouseEvent(tabId, {
          type: 'mouseReleased',
          x,
          y,
          button,
          buttons: 0,
          clickCount,
          modifiers,
        });
      }
    } finally {
      await CDPHelper.detach(tabId).catch(() => {});
    }

    let navigationOccurred = false;
    if (opts.waitForNavigation) {
      const deadline = Date.now() + opts.timeout;
      while (Date.now() < deadline) {
        const current = await chrome.tabs.get(tabId);
        if (current.status === 'loading' || current.url !== urlBefore) navigationOccurred = true;
        if (navigationOccurred && current.status === 'complete') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'Clicked with trusted input',
            clickMethod: 'trusted',
            point: { x: Math.round(x), y: Math.round(y) },
            navigationOccurred,
          }),
        },
      ],
      isError: false,
    };
  }
}

export const clickTool = new ClickTool();

interface FillToolParams {
  selector?: string;
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  ref?: string; // Element ref from accessibility tree
  // Accept string | number | boolean for broader form input coverage
  value: string | number | boolean;
  frameId?: number;
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
}

/**
 * Tool for filling form elements on web pages
 */
class FillTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILL;

  /**
   * Execute fill operation
   */
  async execute(args: FillToolParams): Promise<ToolResult> {
    const { selector, selectorType = 'css', ref, value, frameId } = args;

    console.log(`Starting fill operation with options:`, args);

    if (!selector && !ref) {
      return createErrorResponse(ERROR_MESSAGES.INVALID_PARAMETERS + ': Provide ref or selector');
    }

    if (value === undefined || value === null) {
      return createErrorResponse(ERROR_MESSAGES.INVALID_PARAMETERS + ': Value must be provided');
    }

    try {
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      let finalRef = ref;
      let finalSelector = selector;

      // If selector is XPath, convert to ref first
      if (selector && selectorType === 'xpath') {
        await this.injectContentScript(tab.id, ['inject-scripts/accessibility-tree-helper.js']);
        try {
          const resolved = await this.sendMessageToTab(
            tab.id,
            {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector,
              isXPath: true,
            },
            frameId,
          );
          if (resolved && resolved.success && resolved.ref) {
            finalRef = resolved.ref;
            finalSelector = undefined; // Use ref instead of selector
          } else {
            return createErrorResponse(
              `Failed to resolve XPath selector: ${resolved?.error || 'unknown error'}`,
            );
          }
        } catch (error) {
          return createErrorResponse(
            `Error resolving XPath: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      await this.injectContentScript(tab.id, ['inject-scripts/fill-helper.js']);

      // Send fill message to content script
      const result = await this.sendMessageToTab(
        tab.id,
        {
          action: TOOL_MESSAGE_TYPES.FILL_ELEMENT,
          selector: finalSelector,
          ref: finalRef,
          value,
        },
        frameId,
      );

      if (result && result.error) {
        return createErrorResponse(result.error);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: result.message || 'Fill operation successful',
              elementInfo: result.elementInfo,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in fill operation:', error);
      return createErrorResponse(
        `Error filling element: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const fillTool = new FillTool();
