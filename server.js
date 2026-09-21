'use strict';

const path = require('node:path');
const express = require('express');
const { layout, layoutBatch, layoutCompare } = require('./src/packer');
const { layoutCostBatch } = require('./src/cost');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/layout', (req, res) => {
  try {
    const body = req.body || {};
    const result = layout(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 方案比选：同一输入按三种确定性策略分别试排，按比选目标择优
app.post('/api/layout/compare', (req, res) => {
  try {
    const body = req.body || {};
    const result = layoutCompare(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 批量排产：逐张排样直到完成 / 达到上限 / 某张纸无进展
app.post('/api/layout/batch', (req, res) => {
  try {
    const body = req.body || {};
    const result = layoutBatch(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 多纸型成本排产：2～8 种候选纸逐轮按单位面积成本择优
app.post('/api/layout/cost', (req, res) => {
  try {
    const body = req.body || {};
    const result = layoutCostBatch(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

app.listen(PORT, () => {
  console.log(`单张纸裁切试排服务已启动: http://localhost:${PORT}`);
});

module.exports = app;
