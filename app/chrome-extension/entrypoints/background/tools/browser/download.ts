import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';

// Agents usually click first and wait afterwards, so also accept downloads that started
// shortly before the call.
const RECENT_DOWNLOAD_WINDOW_MS = 15000;
const POLL_INTERVAL_MS = 300;

interface HandleDownloadParams {
  filenameContains?: string;
  timeoutMs?: number; // default 60000
  waitForComplete?: boolean; // default true
}

/**
 * Tool: wait for a download and return info
 */
class HandleDownloadTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.HANDLE_DOWNLOAD as any;

  async execute(args: HandleDownloadParams): Promise<ToolResult> {
    const filenameContains = String(args?.filenameContains || '').trim();
    const waitForComplete = args?.waitForComplete !== false;
    const timeoutMs = Math.max(1000, Math.min(Number(args?.timeoutMs ?? 60000), 300000));

    try {
      const result = await waitForDownload({ filenameContains, waitForComplete, timeoutMs });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, download: result }) }],
        isError: false,
      };
    } catch (e: any) {
      return createErrorResponse(`Handle download failed: ${e?.message || String(e)}`);
    }
  }
}

const baseName = (path?: string) => (path || '').split(/[/\\]/).pop() || '';

/**
 * Poll instead of listening to download events: a small file can be created and finished
 * before a listener is attached, and Chrome does not replay those events.
 */
async function waitForDownload(opts: {
  filenameContains?: string;
  waitForComplete: boolean;
  timeoutMs: number;
}) {
  const { filenameContains, waitForComplete, timeoutMs } = opts;
  const matches = (item: chrome.downloads.DownloadItem) =>
    !filenameContains ||
    baseName(item.filename).includes(filenameContains) ||
    (item.url || '').includes(filenameContains) ||
    (item.finalUrl || '').includes(filenameContains);
  const startedAfter = new Date(Date.now() - RECENT_DOWNLOAD_WINDOW_MS).toISOString();
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const items = await chrome.downloads.search({ startedAfter, orderBy: ['-startTime'] });
    const latest = items.find(matches);
    if (latest?.state === 'complete' || (latest && !waitForComplete)) {
      return {
        id: latest.id,
        filename: latest.filename,
        url: latest.url,
        mime: latest.mime || undefined,
        fileSize: latest.fileSize ?? latest.totalBytes ?? undefined,
        state: latest.state,
        danger: latest.danger,
        startTime: latest.startTime,
        endTime: latest.endTime || undefined,
        exists: latest.exists,
      };
    }
    if (latest?.state === 'interrupted') {
      throw new Error(
        `Download interrupted (${latest.error || 'unknown reason'}): ${baseName(latest.filename) || latest.url}`,
      );
    }
    if (Date.now() >= deadline) {
      const recent = items
        .slice(0, 5)
        .map((d) => `${baseName(d.filename) || '(unnamed)'} [${d.state}]`)
        .join('; ');
      throw new Error(`Download wait timed out${recent ? `; recent downloads: ${recent}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

export const handleDownloadTool = new HandleDownloadTool();
