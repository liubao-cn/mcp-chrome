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

    <pre class="config">{{ mcpConfigJson }}</pre>
  </div>
</template>

<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';

type ServerStatus = { isRunning: boolean; port?: number; lastUpdated?: number };

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
  width: 320px;
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
  margin: 0;
  padding: 8px;
  background: #f3f4f6;
  border-radius: 6px;
  font-size: 11px;
  white-space: pre-wrap;
}
</style>
