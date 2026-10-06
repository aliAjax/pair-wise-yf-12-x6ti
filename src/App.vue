<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { storeToRefs } from "pinia";
import { useLedgerStore } from "./store";
import LedgerPanel from "./components/LedgerPanel.vue";
import MergedList from "./components/MergedList.vue";
import PendingList from "./components/PendingList.vue";
import { fmtTime } from "./format";

const store = useLedgerStore();
const { online, metrics, logs } = storeToRefs(store);

const metricCards = [
  { key: "total", label: "油站数（合并后）" },
  { key: "open", label: "营业中" },
  { key: "tight", label: "库存紧张" },
  { key: "conflicts", label: "待确认" },
  { key: "pending", label: "本地待同步" },
  { key: "failed", label: "同步失败" },
] as const;

const onOnline = () => store.setOnline(true);
const onOffline = () => store.setOnline(false);

onMounted(() => {
  store.setOnline(navigator.onLine);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
});

onUnmounted(() => {
  window.removeEventListener("online", onOnline);
  window.removeEventListener("offline", onOffline);
});
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 双台账合并</p>
          <h1>油站网点台账管理</h1>
          <p class="subtitle">
            巡检与调度台各记一份油站信息，带改动时间和来源；两边都动过时，库存按盘点时间较新的算、营业状态听现场确认的，被压过的一方进待确认清单，处置后合成一条。
          </p>
        </div>
        <div class="net-box">
          <span class="pill" :class="online ? 'sync-synced' : 'sync-failed'">{{ online ? "在线" : "断网" }}</span>
          <button type="button" class="secondary" @click="store.setOnline(!online)">
            {{ online ? "模拟断网" : "恢复网络" }}
          </button>
          <button type="button" :disabled="!online" @click="store.syncAll()">立即合并</button>
        </div>
      </header>

      <section class="metrics">
        <article v-for="card in metricCards" :key="card.key" class="metric">
          <span>{{ card.label }}</span>
          <strong>{{ metrics[card.key] }}</strong>
        </article>
      </section>

      <section class="workspace">
        <div class="col">
          <LedgerPanel source="inspection" />
          <LedgerPanel source="dispatch" />
        </div>
        <div class="col">
          <MergedList />
          <PendingList />
          <section class="panel">
            <h2>同步日志</h2>
            <div v-if="logs.length === 0" class="empty">暂无日志</div>
            <ul class="log-list">
              <li v-for="l in logs" :key="l.id" :class="`log-${l.kind}`">
                <span>{{ fmtTime(l.time) }}</span>{{ l.text }}
              </li>
            </ul>
          </section>
        </div>
      </section>
    </div>
  </main>
</template>
