<template>
  <div class="slim-popup">
    <h1>Chrome MCP Server</h1>

    <section class="row">
      <span>连接状态</span>
      <strong :class="nativeConnectionStatus">{{ statusText }}</strong>
    </section>

    <section class="row">
      <span>服务端口</span>
      <input v-model.number="nativeServerPort" type="number" min="1" max="65535" />
    </section>

    <section class="row">
      <span>MCP 服务</span>
      <strong>{{ serverText }}</strong>
    </section>

    <div class="actions">
      <button :disabled="isConnecting" @click="toggleConnection">
        {{ nativeConnectionStatus === 'connected' ? '断开' : '连接' }}
      </button>
      <button @click="refreshServerStatus">刷新</button>
      <button @click="copyMcpConfig">{{ copyButtonText }}</button>
    </div>

    <section class="capabilities">
      <h2>能做什么（{{ toolCount }} 个工具）</h2>
      <table>
        <tbody>
          <tr v-for="row in capabilityRows" :key="row.label">
            <th>{{ row.label }}</th>
            <td>
              <div>{{ row.summary }}</div>
              <div class="tool-names">{{ row.tools.join(' · ') }}</div>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <details class="config-block">
      <summary>MCP 配置</summary>
      <pre class="config">{{ mcpConfigJson }}</pre>
    </details>

    <footer>扩展 v{{ version }} · slim 精简版</footer>
  </div>
</template>

<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { TOOL_NAMES, TOOL_SCHEMAS } from 'chrome-mcp-shared';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';

type ServerStatus = { isRunning: boolean; port?: number; lastUpdated?: number };

const B = TOOL_NAMES.BROWSER;
const CAPABILITY_GROUPS: { label: string; summary: string; tools: string[] }[] = [
  {
    label: '标签页',
    summary: '列出、打开、切换、关闭标签页和窗口',
    tools: [B.GET_WINDOWS_AND_TABS, B.NAVIGATE, B.SWITCH_TAB, B.CLOSE_TABS],
  },
  {
    label: '读页面',
    summary: '读页面结构（可只取可交互元素）、取正文、截图',
    tools: [B.READ_PAGE, B.WEB_FETCHER, B.SCREENSHOT],
  },
  {
    label: '操作',
    summary: '真实鼠标点击、填表和下拉、键盘输入、按坐标拖拽和滚动',
    tools: [B.CLICK, B.FILL, B.KEYBOARD, B.COMPUTER],
  },
  {
    label: '等待',
    summary: '等元素出现或消失、等文字、等网址变化、等网络空闲',
    tools: [B.WAIT_FOR],
  },
  {
    label: '调试',
    summary: '执行 JS、看控制台、抓网络请求、带登录态发请求',
    tools: [B.JAVASCRIPT, B.CONSOLE, B.NETWORK_CAPTURE, B.NETWORK_REQUEST],
  },
  {
    label: '文件与弹窗',
    summary: '上传文件、等下载完成、处理 alert / confirm / prompt',
    tools: [B.FILE_UPLOAD, B.HANDLE_DOWNLOAD, B.HANDLE_DIALOG],
  },
];

// Driven by the schemas actually exposed over MCP, so the table cannot drift from the tool list.
const exposedTools = TOOL_SCHEMAS.map((tool) => tool.name);
const groupedTools = new Set(CAPABILITY_GROUPS.flatMap((group) => group.tools));
const ungroupedTools = exposedTools.filter((name) => !groupedTools.has(name));
const shortName = (name: string) => name.replace(/^chrome_/, '');
const capabilityRows = [
  ...CAPABILITY_GROUPS.map((group) => ({
    ...group,
    tools: group.tools.filter((name) => exposedTools.includes(name)).map(shortName),
  })),
  ...(ungroupedTools.length
    ? [{ label: '其他', summary: '未归类的工具', tools: ungroupedTools.map(shortName) }]
    : []),
].filter((row) => row.tools.length > 0);
const toolCount = exposedTools.length;
const version = chrome.runtime.getManifest().version;

const nativeConnectionStatus = ref<'connected' | 'disconnected' | 'unknown'>('unknown');
const serverStatus = ref<ServerStatus>({ isRunning: false });
const nativeServerPort = ref<number>(12306);
const isConnecting = ref(false);
const copyButtonText = ref('复制配置');

const statusText = computed(() =>
  nativeConnectionStatus.value === 'connected'
    ? '已连接'
    : nativeConnectionStatus.value === 'disconnected'
      ? '已断开'
      : '检测中…',
);

const serverText = computed(() =>
  serverStatus.value.isRunning
    ? `运行中（端口 ${serverStatus.value.port ?? nativeServerPort.value}）`
    : '未运行',
);

const mcpConfigJson = computed(() =>
  JSON.stringify(
    {
      mcpServers: {
        'chrome-mcp-server': {
          type: 'streamableHttp',
          url: `http://127.0.0.1:${serverStatus.value.port ?? nativeServerPort.value}/mcp`,
        },
      },
    },
    null,
    2,
  ),
);

const applyStatus = (response: any) => {
  if (response?.serverStatus) serverStatus.value = response.serverStatus;
  if (response?.connected !== undefined) {
    nativeConnectionStatus.value = response.connected ? 'connected' : 'disconnected';
  }
};

const checkServerStatus = async () => {
  try {
    applyStatus(
      await chrome.runtime.sendMessage({ type: BACKGROUND_MESSAGE_TYPES.GET_SERVER_STATUS }),
    );
  } catch {
    nativeConnectionStatus.value = 'disconnected';
  }
};

const refreshServerStatus = async () => {
  try {
    applyStatus(
      await chrome.runtime.sendMessage({ type: BACKGROUND_MESSAGE_TYPES.REFRESH_SERVER_STATUS }),
    );
  } catch {
    nativeConnectionStatus.value = 'disconnected';
  }
};

const toggleConnection = async () => {
  if (isConnecting.value) return;
  isConnecting.value = true;
  try {
    if (nativeConnectionStatus.value === 'connected') {
      await chrome.runtime.sendMessage({ type: 'disconnect_native' });
      nativeConnectionStatus.value = 'disconnected';
    } else {
      const response = await chrome.runtime.sendMessage({
        type: 'connectNative',
        port: nativeServerPort.value,
      });
      nativeConnectionStatus.value = response?.success ? 'connected' : 'disconnected';
      if (response?.success)
        await chrome.storage.local.set({ nativeServerPort: nativeServerPort.value });
    }
  } finally {
    isConnecting.value = false;
    await checkServerStatus();
  }
};

const copyMcpConfig = async () => {
  try {
    await navigator.clipboard.writeText(mcpConfigJson.value);
    copyButtonText.value = '已复制';
  } catch {
    copyButtonText.value = '复制失败';
  }
  setTimeout(() => (copyButtonText.value = '复制配置'), 2000);
};

const onMessage = (message: any) => {
  if (message?.type === BACKGROUND_MESSAGE_TYPES.SERVER_STATUS_CHANGED && message.payload) {
    serverStatus.value = message.payload;
  }
};

onMounted(async () => {
  const stored = await chrome.storage.local.get(['nativeServerPort']);
  if (stored.nativeServerPort) nativeServerPort.value = stored.nativeServerPort;
  chrome.runtime.onMessage.addListener(onMessage);
  await checkServerStatus();
});

onUnmounted(() => chrome.runtime.onMessage.removeListener(onMessage));
</script>

<style scoped>
.slim-popup {
  box-sizing: border-box;
  width: 100%;
  padding: 16px;
  font:
    13px/1.5 -apple-system,
    BlinkMacSystemFont,
    'PingFang SC',
    sans-serif;
  color: #1f2937;
}
h1 {
  margin: 0 0 12px;
  font-size: 15px;
}
.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.row input {
  width: 90px;
}
.connected {
  color: #059669;
}
.disconnected {
  color: #dc2626;
}
.actions {
  display: flex;
  gap: 8px;
  margin: 12px 0;
}
.actions button {
  flex: 1;
  padding: 6px 0;
  cursor: pointer;
}
.config {
  margin: 6px 0 0;
  padding: 8px;
  background: #f3f4f6;
  border-radius: 6px;
  font-size: 11px;
  white-space: pre-wrap;
}
.capabilities h2 {
  margin: 4px 0 6px;
  font-size: 13px;
}
.capabilities table {
  width: 100%;
  border-collapse: collapse;
}
.capabilities th,
.capabilities td {
  padding: 5px 4px;
  border-top: 1px solid #e5e7eb;
  text-align: left;
  vertical-align: top;
}
.capabilities th {
  width: 64px;
  font-weight: 600;
  white-space: nowrap;
}
.tool-names {
  margin-top: 2px;
  color: #6b7280;
  font:
    10px/1.4 ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  overflow-wrap: anywhere;
}
.config-block {
  margin-top: 10px;
}
.config-block summary {
  cursor: pointer;
  color: #374151;
}
footer {
  margin-top: 10px;
  color: #9ca3af;
  font-size: 11px;
}
</style>
