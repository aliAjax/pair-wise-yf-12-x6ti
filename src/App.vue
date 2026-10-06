<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { storeToRefs } from "pinia";
import {
  AREAS,
  STATUSES,
  SOURCE_LABELS,
  useLedgerStore,
  type IncomingRecord,
  type Source,
} from "./stores/ledger";

const project = {
  industry: "石油",
  title: "油站网点地图管理",
  subtitle: "巡检与调度台各记一份油站信息，带改动时间和来源；库存按盘点时间合并，营业状态听现场确认，断网先记本地、回网再合并。",
  stack: ["Vue3", "Vite", "TypeScript", "Pinia"],
};

const store = useLedgerStore();
const { mergedList, metrics, pending, outbox, rejected, online, merging } = storeToRefs(store);

const sources: Source[] = ["inspection", "dispatch"];
const filters = ["全部区域", ...AREAS];

const form = reactive({
  source: "inspection" as Source,
  station: "",
  area: "",
  stock: 0,
  stockCountedAt: "",
  status: "营业中",
  statusConfirmed: false,
  manager: "",
  note: "",
});

const batch = ref<IncomingRecord[]>([]);
const filter = ref("全部区域");

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatTime(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function handleOnline() {
  store.setOnline(true);
}
function handleOffline() {
  store.setOnline(false);
}

onMounted(() => {
  store.init();
  form.stockCountedAt = toLocalInput(new Date());
  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);
});

onBeforeUnmount(() => {
  window.removeEventListener("online", handleOnline);
  window.removeEventListener("offline", handleOffline);
});

function addToBatch() {
  const name = form.station.trim();
  if (!name || !form.area) return;
  batch.value.push({
    source: form.source,
    station: name,
    area: form.area,
    stock: Number(form.stock) || 0,
    stockCountedAt: form.stockCountedAt ? new Date(form.stockCountedAt).toISOString() : new Date().toISOString(),
    status: form.status,
    statusConfirmed: form.statusConfirmed,
    manager: form.manager,
    note: form.note,
  });
  form.station = "";
  form.area = "";
  form.stock = 0;
  form.status = "营业中";
  form.statusConfirmed = false;
  form.manager = "";
  form.note = "";
}

async function submitBatch() {
  if (batch.value.length === 0) return;
  const result = await store.submitBatch(batch.value);
  if (result.ok) batch.value = [];
}

const filteredList = computed(() => {
  if (filter.value === "全部区域") return mergedList.value;
  return mergedList.value.filter((station) => station.area === filter.value);
});

const chartRows = computed(() =>
  STATUSES.map((status) => ({
    status,
    value: mergedList.value.filter((station) => station.status === status).length,
  }))
);

const maxChart = computed(() => Math.max(1, ...chartRows.value.map((row) => row.value)));

const outboxRecordCount = computed(() =>
  outbox.value.reduce((acc, item) => acc + item.records.length, 0)
);

function sideText(station: (typeof mergedList.value)[number], source: Source) {
  const side = station.sides[source];
  if (!side) return "未填报";
  const confirmed = side.statusConfirmed ? "（现场确认）" : "";
  return `库存 ${side.stock}L · 盘点 ${formatTime(side.stockCountedAt)} · ${side.status}${confirmed} · 改动 ${formatTime(side.updatedAt)}`;
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">{{ project.industry }}行业 · 双端台账各存一份</p>
          <h1>{{ project.title }}</h1>
          <p class="subtitle">{{ project.subtitle }}</p>
        </div>
        <div class="stack">
          <span v-for="item in project.stack" :key="item" class="tag">{{ item }}</span>
          <span class="tag" :class="online ? 'tag-online' : 'tag-offline'">
            <i class="dot" :class="online ? 'dot-online' : 'dot-offline'"></i>
            {{ online ? "在线" : "断网" }}
          </span>
        </div>
      </header>

      <section class="metrics">
        <article class="metric">
          <span>油站数（合并后）</span>
          <strong>{{ metrics.total }}</strong>
        </article>
        <article class="metric">
          <span>营业中</span>
          <strong>{{ metrics.open }}</strong>
        </article>
        <article class="metric">
          <span>库存紧张</span>
          <strong>{{ metrics.tight }}</strong>
        </article>
        <article class="metric">
          <span>待确认</span>
          <strong>{{ metrics.pending }}</strong>
        </article>
      </section>

      <section class="workspace">
        <form class="panel" @submit.prevent="submitBatch">
          <h2>录入油站信息</h2>
          <div class="form-grid">
            <div class="segmented" role="group" aria-label="来源">
              <button
                v-for="source in sources"
                :key="source"
                type="button"
                :class="{ active: form.source === source }"
                @click="form.source = source"
              >
                {{ SOURCE_LABELS[source] }}填报
              </button>
            </div>
            <label>
              油站名称
              <input v-model="form.station" placeholder="如：东区一站" required />
            </label>
            <label>
              区域
              <select v-model="form.area" required>
                <option value="">请选择</option>
                <option v-for="area in AREAS" :key="area" :value="area">{{ area }}</option>
              </select>
            </label>
            <label>
              库存摘要（L）
              <input v-model.number="form.stock" type="number" min="0" />
            </label>
            <label>
              盘点时间
              <input v-model="form.stockCountedAt" type="datetime-local" />
            </label>
            <label>
              营业状态
              <select v-model="form.status">
                <option v-for="status in STATUSES" :key="status" :value="status">{{ status }}</option>
              </select>
            </label>
            <label class="check">
              <input v-model="form.statusConfirmed" type="checkbox" />
              营业状态已经现场确认
            </label>
            <label>
              负责人
              <input v-model="form.manager" placeholder="如：刘站长" />
            </label>
            <label>
              备注
              <textarea v-model="form.note" placeholder="填写处理说明或现场备注" />
            </label>
            <button type="button" :disabled="!form.station.trim() || !form.area" @click="addToBatch">
              加入批次
            </button>
          </div>

          <div v-if="batch.length" class="batch">
            <p class="batch-title">待提交批次（{{ batch.length }} 条，带来源和改动时间）</p>
            <div v-for="(record, index) in batch" :key="index" class="chip">
              <span>{{ SOURCE_LABELS[record.source] }} · {{ record.station }} · {{ record.area }} · {{ record.stock }}L · {{ record.status }}</span>
              <button type="button" class="chip-x" @click="batch.splice(index, 1)">×</button>
            </div>
            <div class="batch-actions">
              <button type="submit" :disabled="merging">
                {{ online ? "提交批次并合并" : "断网：先记本地，回网合并" }}
              </button>
              <button type="button" class="secondary" @click="batch = []">清空批次</button>
            </div>
          </div>
        </form>

        <section class="list-panel">
          <div class="toolbar">
            <h2>油站列表（按合并结果）</h2>
            <select v-model="filter">
              <option v-for="item in filters" :key="item" :value="item">{{ item }}</option>
            </select>
          </div>

          <div v-if="!online" class="banner banner-warn">
            当前断网：新记录先记本地（共 {{ outbox.length }} 批 / {{ outboxRecordCount }} 条），回网后自动合并；指标和列表只反映合并结果。
          </div>

          <div v-if="outbox.length" class="banner banner-error">
            <p class="banner-title">待合并队列（{{ outbox.length }} 批 / {{ outboxRecordCount }} 条）：合并失败后已留住原因，可重试</p>
            <div v-for="item in outbox" :key="item.id" class="outbox-item">
              <div class="outbox-meta">
                批次 {{ item.id.slice(0, 6) }} · {{ item.records.length }} 条 · 已重试 {{ item.attempts }} 次
                <span v-if="item.lastError"> · 失败原因：{{ item.lastError }}</span>
                <span v-else> · 等待回网合并</span>
              </div>
              <button type="button" :disabled="!online || merging" @click="store.retryItem(item.id)">重试</button>
            </div>
            <div class="batch-actions">
              <button type="button" :disabled="!online || merging" @click="store.flushOutbox()">全部重试合并</button>
            </div>
          </div>

          <div v-if="rejected.length" class="banner banner-error">
            <p class="banner-title">上一批次未通过校验，整批停下（未入库、未入队）：</p>
            <div v-for="(item, index) in rejected" :key="index" class="rejected-item">
              {{ item.station }}（{{ item.area }}）— {{ item.reason }}
            </div>
          </div>

          <div v-if="pending.length" class="banner banner-info">
            <p class="banner-title">待确认清单（{{ pending.length }} 条）：营业状态需现场确认，处置后才合成一条</p>
            <div v-for="item in pending" :key="item.id" class="pending-item">
              <div class="pending-meta">
                <strong>{{ item.station }}</strong> · {{ SOURCE_LABELS[item.source] }} 报「{{ item.status }}」 · {{ item.reason }}
              </div>
              <div class="actions">
                <button type="button" @click="store.handlePending(item.id, 'confirm')">确认现场状态</button>
                <button type="button" class="secondary" @click="store.handlePending(item.id, 'dismiss')">维持现状</button>
              </div>
            </div>
          </div>

          <div class="record-grid">
            <div v-if="filteredList.length === 0" class="empty">暂无匹配数据</div>
            <article v-for="station in filteredList" :key="station.id" class="record">
              <div class="record-head">
                <p class="record-title">
                  {{ station.station }}
                  <span class="area-tag">{{ station.area }}</span>
                </p>
                <span class="status">
                  {{ station.status }}
                  <template v-if="station.statusSource"> · {{ SOURCE_LABELS[station.statusSource] }}确认</template>
                </span>
              </div>
              <div class="details">
                <span>负责人：{{ station.manager }}</span>
                <span>
                  库存：{{ station.stock }}L
                  （{{ station.stockSource ? SOURCE_LABELS[station.stockSource] : "—" }} · 盘点 {{ formatTime(station.stockCountedAt) }}）
                </span>
                <span>最近改动：{{ formatTime(station.updatedAt) }}</span>
              </div>
              <div class="sides">
                <div
                  v-for="source in sources"
                  :key="source"
                  class="side"
                  :class="{ 'side-winner': station.stockSource === source || station.statusSource === source }"
                >
                  <strong>{{ SOURCE_LABELS[source] }}</strong>
                  <span>{{ sideText(station, source) }}</span>
                </div>
              </div>
              <p class="note">{{ station.note }}</p>
              <div class="actions">
                <button class="danger" type="button" @click="store.removeStation(station.id)">删除</button>
              </div>
            </article>
          </div>

          <div class="mini-chart">
            <div v-for="row in chartRows" :key="row.status" class="bar">
              <span>{{ row.status }}</span>
              <div class="bar-track"><div class="bar-fill" :style="{ width: `${(row.value / maxChart) * 100}%` }" /></div>
              <strong>{{ row.value }}</strong>
            </div>
          </div>
        </section>
      </section>
    </div>
  </main>
</template>
