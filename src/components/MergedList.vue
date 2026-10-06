<script setup lang="ts">
import { computed, ref } from "vue";
import { storeToRefs } from "pinia";
import { useLedgerStore } from "../store";
import { AREAS, SOURCE_LABEL } from "../types";
import { fmtTime } from "../format";

const store = useLedgerStore();
const { merged, chartRows } = storeToRefs(store);

const filter = ref("全部区域");
const filters = ["全部区域", ...AREAS];

const filtered = computed(() =>
  filter.value === "全部区域" ? merged.value : merged.value.filter((m) => m.area === filter.value)
);

const maxChart = computed(() => Math.max(1, ...chartRows.value.map((r) => r.value)));
</script>

<template>
  <section class="list-panel">
    <div class="toolbar">
      <h2>合并台账</h2>
      <select v-model="filter">
        <option v-for="f in filters" :key="f">{{ f }}</option>
      </select>
    </div>
    <p class="hint">列表与指标均按合并结果计算；有待确认项的站，处置后才最终合成一条。</p>

    <div class="record-grid">
      <div v-if="filtered.length === 0" class="empty">暂无匹配数据</div>
      <article v-for="m in filtered" :key="m.station" class="record">
        <div class="record-head">
          <p class="record-title">{{ m.station }} / {{ m.area }}</p>
          <span class="status">{{ m.status }}</span>
        </div>
        <div class="details">
          <span>库存：{{ m.stock }}L（{{ SOURCE_LABEL[m.stockSource] }}盘点 {{ fmtTime(m.stockAt) }}）</span>
          <span>
            营业状态：{{ m.status }}（{{ SOURCE_LABEL[m.statusSource]
            }}<template v-if="m.confirmed"> · 现场确认</template><template v-else> · 未现场确认</template>）
          </span>
          <span>负责人：{{ m.manager }}</span>
          <span>最近改动：{{ fmtTime(m.updatedAt) }}</span>
        </div>
        <div class="merge-state">
          <span v-for="s in m.sources" :key="s" class="tag">{{ SOURCE_LABEL[s] }}</span>
          <span v-if="m.openConflicts > 0" class="pill sync-pending">待确认 {{ m.openConflicts }} 项 · 处置后合成一条</span>
          <span v-else class="pill sync-synced">已合成一条</span>
        </div>
        <p v-if="m.notes" class="note">{{ m.notes }}</p>
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
</template>
