<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useLedgerStore, parseBatchText } from "../store";
import { AREAS, SOURCE_LABEL, STATUSES, SYNC_LABEL, type LedgerEntry, type Source, type StationPayload } from "../types";
import { fmtTime, fromLocalInput, toLocalInput } from "../format";

const props = defineProps<{ source: Source }>();

const store = useLedgerStore();
const { ledgers, fixingId, online } = storeToRefs(store);

const blank = (): StationPayload & { stockAtInput: string } => ({
  station: "",
  area: "",
  stock: 0,
  stockAt: new Date().toISOString(),
  stockAtInput: toLocalInput(new Date().toISOString()),
  status: STATUSES[0],
  confirmed: props.source === "inspection",
  manager: "",
  notes: "",
});

const form = reactive(blank());
const batchText = ref("");
const showBatch = ref(false);
const errors = ref<string[]>([]);
const notice = ref("");

/** 当前处于修正模式的条目（若有） */
const fixingEntry = computed(() =>
  ledgers.value[props.source].find((e) => e.id === fixingId.value) ?? null
);

watch(fixingEntry, (entry) => {
  if (!entry) return;
  Object.assign(form, {
    station: entry.station,
    area: entry.area,
    stock: entry.stock,
    stockAt: entry.stockAt,
    stockAtInput: toLocalInput(entry.stockAt),
    status: entry.status,
    confirmed: entry.confirmed,
    manager: entry.manager,
    notes: entry.notes,
  });
  showBatch.value = false;
});

function toPayload(): StationPayload {
  return {
    station: form.station,
    area: form.area,
    stock: Number(form.stock) || 0,
    stockAt: fromLocalInput(form.stockAtInput),
    status: form.status,
    confirmed: form.confirmed,
    manager: form.manager || "—",
    notes: form.notes,
  };
}

function handleResult(result: { ok: boolean; queued?: boolean; errors?: string[] }) {
  errors.value = result.errors ?? [];
  if (result.ok) {
    notice.value = result.queued ? "已断网：先记本地，回网后自动合并" : "已入库并合并";
    Object.assign(form, blank());
    batchText.value = "";
    setTimeout(() => (notice.value = ""), 3000);
  }
}

function submit() {
  notice.value = "";
  if (fixingEntry.value) {
    store.applyFix(props.source, toPayload());
    Object.assign(form, blank());
    return;
  }
  handleResult(store.submitBatch(props.source, [toPayload()]));
}

function submitBatchText() {
  notice.value = "";
  const payloads = parseBatchText(batchText.value, props.source);
  handleResult(store.submitBatch(props.source, payloads));
}

function cancelFix() {
  store.cancelFix();
  Object.assign(form, blank());
}

const entries = computed(() =>
  [...ledgers.value[props.source]].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30)
);

const stateClass = (e: LedgerEntry) => `sync-${e.syncState}`;
</script>

<template>
  <section class="panel ledger-panel">
    <h2>{{ SOURCE_LABEL[source] }}台账</h2>
    <p class="hint">每条记录带改动时间与来源；同名再报视为更新本站这一份。</p>

    <form class="form-grid" @submit.prevent="submit">
      <label>
        油站名称
        <input v-model="form.station" required placeholder="如：东区一站" />
      </label>
      <div class="field-row">
        <label>
          区域
          <select v-model="form.area" required>
            <option value="">请选择</option>
            <option v-for="a in AREAS" :key="a">{{ a }}</option>
          </select>
        </label>
        <label>
          营业状态
          <select v-model="form.status">
            <option v-for="s in STATUSES" :key="s">{{ s }}</option>
          </select>
        </label>
      </div>
      <div class="field-row">
        <label>
          库存（L）
          <input v-model="form.stock" type="number" min="0" required />
        </label>
        <label>
          盘点时间
          <input v-model="form.stockAtInput" type="datetime-local" required />
        </label>
      </div>
      <label>
        负责人
        <input v-model="form.manager" placeholder="选填" />
      </label>
      <label class="check-row">
        <input v-model="form.confirmed" type="checkbox" />
        营业状态已经现场确认
      </label>
      <label>
        备注
        <textarea v-model="form.notes" placeholder="处理说明或现场备注" />
      </label>
      <div class="btn-row">
        <button type="submit">{{ fixingEntry ? "保存修正并重试" : online ? "提交并合并" : "先记本地" }}</button>
        <button v-if="fixingEntry" type="button" class="secondary" @click="cancelFix">取消修正</button>
        <button v-else type="button" class="secondary" @click="showBatch = !showBatch">
          {{ showBatch ? "收起批量导入" : "批量导入" }}
        </button>
      </div>
    </form>

    <div v-if="showBatch" class="batch-box">
      <p class="hint">每行一条：站名,区域,库存,状态,负责人,备注。批内重名或区域超出东区/西区/机场线，整批停下。</p>
      <textarea v-model="batchText" rows="4" placeholder="东区三站,东区,18000,营业中,赵站长&#10;南区临时站,南区,5000,营业中"></textarea>
      <button type="button" @click="submitBatchText">导入这一批</button>
    </div>

    <div v-if="errors.length" class="alert">
      <strong>整批未入库，以下条目没进去：</strong>
      <ul>
        <li v-for="(e, i) in errors" :key="i">{{ e }}</li>
      </ul>
    </div>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <div class="entry-list">
      <div v-for="e in entries" :key="e.id" class="entry">
        <div class="entry-head">
          <strong>{{ e.station }}</strong>
          <span class="pill" :class="stateClass(e)">{{ SYNC_LABEL[e.syncState] }}</span>
        </div>
        <p class="entry-line">
          {{ e.area }} · {{ e.status }}<template v-if="e.confirmed">（现场确认）</template>
          · 库存 {{ e.stock }}L @ {{ fmtTime(e.stockAt) }}
        </p>
        <p class="entry-meta">来源 {{ SOURCE_LABEL[e.source] }} · 改动 {{ fmtTime(e.updatedAt) }}</p>
        <p v-if="e.failReason" class="fail-reason">{{ e.failReason }}</p>
        <div v-if="e.syncState !== 'synced'" class="actions">
          <button v-if="e.syncState === 'failed'" type="button" @click="store.startFix(e.id)">修正</button>
          <button v-if="e.syncState === 'failed'" type="button" class="secondary" @click="store.retryBatch(e.batchId)">重试本批</button>
          <button type="button" class="danger" @click="store.removeEntry(source, e.id)">删除</button>
        </div>
      </div>
      <div v-if="entries.length === 0" class="empty">暂无记录</div>
    </div>
  </section>
</template>
