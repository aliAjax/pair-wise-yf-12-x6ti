<script setup lang="ts">
import { storeToRefs } from "pinia";
import { useLedgerStore } from "../store";
import { FIELD_LABEL, SOURCE_LABEL } from "../types";
import { fmtTime } from "../format";

const store = useLedgerStore();
const { conflicts, resolutions } = storeToRefs(store);

const timeLabel = (field: string) => (field === "stock" ? "盘点时间" : "改动时间");
</script>

<template>
  <section class="panel">
    <h2>待确认清单</h2>
    <p class="hint">两边都动过同一站时，被合并规则压过的一方先挂在这里，处置后才合成一条。</p>

    <div v-if="conflicts.length === 0" class="empty">没有待确认项，台账均已合成一条</div>

    <div v-for="c in conflicts" :key="c.id" class="conflict">
      <div class="record-head">
        <p class="record-title">{{ c.station }} · {{ FIELD_LABEL[c.field] }}</p>
      </div>
      <p class="hint">{{ c.reason }}</p>
      <div class="versus">
        <div class="side kept">
          <span class="tag">合并采用</span>
          <strong>{{ c.kept.value }}<template v-if="c.field === 'stock'">L</template></strong>
          <span>{{ SOURCE_LABEL[c.kept.source] }} · {{ timeLabel(c.field) }} {{ fmtTime(c.kept.at) }}</span>
          <span v-if="c.kept.confirmed" class="tag ok">现场确认</span>
        </div>
        <div class="side dropped">
          <span class="tag">待确认</span>
          <strong>{{ c.dropped.value }}<template v-if="c.field === 'stock'">L</template></strong>
          <span>{{ SOURCE_LABEL[c.dropped.source] }} · {{ timeLabel(c.field) }} {{ fmtTime(c.dropped.at) }}</span>
          <span v-if="c.dropped.confirmed" class="tag ok">现场确认</span>
        </div>
      </div>
      <div class="actions">
        <button type="button" @click="store.resolveConflict(c, 'keep')">维持合并值</button>
        <button type="button" class="secondary" @click="store.resolveConflict(c, 'adopt')">
          改用{{ SOURCE_LABEL[c.dropped.source] }}值
        </button>
      </div>
    </div>

    <template v-if="resolutions.length">
      <h3 class="sub-title">处置记录</h3>
      <ul class="resolution-list">
        <li v-for="r in resolutions.slice(0, 10)" :key="r.id">
          {{ fmtTime(r.at) }} · {{ r.station }} {{ FIELD_LABEL[r.field] }}：{{
            r.choice === "keep" ? "维持合并值" : `改用${SOURCE_LABEL[r.dropped.source]}值`
          }}（{{ SOURCE_LABEL[r.choice === "keep" ? r.kept.source : r.dropped.source] }} {{ r.choice === "keep" ? r.kept.value : r.dropped.value }}）
        </li>
      </ul>
    </template>
  </section>
</template>
