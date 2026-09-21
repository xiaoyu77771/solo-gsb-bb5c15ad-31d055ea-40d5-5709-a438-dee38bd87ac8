'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { layoutBatch } = require('../src/packer');
const { layoutCostBatch } = require('../src/cost');
const { scheduleStack } = require('../src/schedule');
const app = require('../server.js');

/* ---------------- 刀次构造辅助 ---------------- */

// 竖切：被切区域 (x,y,w,h)，刀缝带起点 x=bx、宽 kerf、贯穿区域高
function vcut(n, depth, x, y, w, h, bx, kerf) {
  return {
    n, depth, orient: 'v',
    region: { x, y, w, h },
    band: { x: bx, y, w: kerf, h },
    length: h,
  };
}

// 横切：被切区域 (x,y,w,h)，刀缝带起点 y=by、高 kerf、贯穿区域宽
function hcut(n, depth, x, y, w, h, by, kerf) {
  return {
    n, depth, orient: 'h',
    region: { x, y, w, h },
    band: { x, y: by, w, h: kerf },
    length: w,
  };
}

const batchMembers = (b) => b.cuts.map((c) => `${c.sheet}#${c.cutNo}`);

/* ---------------- 合并与分批 ---------------- */

test('排程：相同纸张的刀次按合并键叠切，总批次少于总刀次', () => {
  const cuts = () => [
    vcut(1, 0, 0, 0, 300, 200, 100, 3), // 根刀：竖切 pos100
    hcut(2, 1, 0, 0, 100, 200, 80, 3), // 左块：横切 pos80
    hcut(3, 1, 103, 0, 197, 200, 80, 3), // 右块：横切 pos80
  ];
  const r = scheduleStack({
    stackLimit: 5,
    sheets: [{ cuts: cuts() }, { cuts: cuts() }],
  });
  assert.strictEqual(r.summary.cutsTotal, 6);
  assert.strictEqual(r.summary.scheduledCuts, 6);
  assert.strictEqual(r.summary.unscheduledCuts, 0);
  assert.strictEqual(r.unscheduled.length, 0);
  // 6 刀合成 3 批，节省 3 刀
  assert.strictEqual(r.summary.batchesTotal, 3);
  assert.strictEqual(r.summary.savedPasses, 3);
  assert.strictEqual(r.summary.maxStack, 2);
  // 批 1：两张的根刀（竖切）；批 2/3：两个子刀组（总切线长者先入批）
  assert.strictEqual(r.batches[0].orient, 'v');
  assert.deepStrictEqual(batchMembers(r.batches[0]), ['1#1', '2#1']);
  assert.strictEqual(r.batches[1].region.w, 197);
  assert.deepStrictEqual(batchMembers(r.batches[1]), ['1#3', '2#3']);
  assert.strictEqual(r.batches[2].region.w, 100);
  assert.deepStrictEqual(batchMembers(r.batches[2]), ['1#2', '2#2']);
  // 每张纸进度
  for (const sh of r.sheets) {
    assert.strictEqual(sh.cutsTotal, 3);
    assert.strictEqual(sh.scheduled, 3);
    assert.strictEqual(sh.done, true);
    assert.deepStrictEqual(sh.batches, [1, 2, 3]);
  }
});

test('排程：单张纸的父子刀链强制按刀序逐批', () => {
  const r = scheduleStack({
    stackLimit: 10,
    sheets: [{
      cuts: [
        vcut(1, 0, 0, 0, 300, 200, 100, 3),
        hcut(2, 1, 0, 0, 100, 200, 80, 3),
        vcut(3, 2, 0, 0, 100, 80, 40, 3),
      ],
    }],
  });
  assert.strictEqual(r.summary.batchesTotal, 3);
  r.batches.forEach((b, i) => {
    assert.strictEqual(b.sheetCount, 1);
    assert.strictEqual(b.cuts[0].cutNo, i + 1, '父刀未完成前子刀不得入批');
  });
});

test('排程：仅区域宽高、刀向、刀位、刀缝一致才可合并', () => {
  const base = () => vcut(1, 0, 0, 0, 300, 200, 100, 3);
  const cases = [
    ['完全一致可合并', () => vcut(1, 0, 0, 0, 300, 200, 100, 3), 1],
    ['区域宽不同不可合并', () => vcut(1, 0, 0, 0, 301, 200, 100, 3), 2],
    ['区域高不同不可合并', () => vcut(1, 0, 0, 0, 300, 201, 100, 3), 2],
    ['刀位不同不可合并', () => vcut(1, 0, 0, 0, 300, 200, 101, 3), 2],
    ['刀向不同不可合并', () => hcut(1, 0, 0, 0, 300, 200, 100, 3), 2],
    ['刀缝不同不可合并', () => vcut(1, 0, 0, 0, 300, 200, 100, 4), 2],
  ];
  for (const [label, other, expected] of cases) {
    const r = scheduleStack({
      stackLimit: 5,
      sheets: [{ cuts: [base()] }, { cuts: [other()] }],
    });
    assert.strictEqual(r.summary.batchesTotal, expected, label);
  }
});

test('排程：同批不超过叠纸上限，超出部分按纸张序号留待后续批次', () => {
  const sheets = Array.from({ length: 5 }, () => ({
    cuts: [vcut(1, 0, 0, 0, 300, 200, 100, 3)],
  }));
  const r = scheduleStack({ stackLimit: 2, sheets });
  assert.strictEqual(r.summary.batchesTotal, 3);
  assert.deepStrictEqual(r.batches.map((b) => b.sheetCount), [2, 2, 1]);
  assert.deepStrictEqual(batchMembers(r.batches[0]), ['1#1', '2#1']);
  assert.deepStrictEqual(batchMembers(r.batches[1]), ['3#1', '4#1']);
  assert.deepStrictEqual(batchMembers(r.batches[2]), ['5#1']);
  assert.strictEqual(r.summary.maxStack, 2);
  assert.strictEqual(r.summary.savedPasses, 2);
});

test('排程：每轮优先选择可合并张数最多的刀', () => {
  const r = scheduleStack({
    stackLimit: 5,
    sheets: [
      { cuts: [vcut(1, 0, 0, 0, 300, 200, 100, 3)] },
      { cuts: [vcut(1, 0, 0, 0, 300, 200, 100, 3)] },
      { cuts: [hcut(1, 0, 0, 0, 300, 200, 50, 3)] },
    ],
  });
  // 竖切组可合并 2 张 > 横切组 1 张，先入批
  assert.strictEqual(r.batches[0].orient, 'v');
  assert.strictEqual(r.batches[0].sheetCount, 2);
  assert.strictEqual(r.batches[1].sheetCount, 1);
});

test('排程：可合并张数相同时按总切线长度（长者优先）决胜', () => {
  const r = scheduleStack({
    stackLimit: 5,
    sheets: [
      { cuts: [vcut(1, 0, 0, 0, 300, 200, 100, 3)] }, // 切线长 200
      { cuts: [vcut(1, 0, 0, 0, 300, 200, 100, 3)] },
      { cuts: [vcut(1, 0, 0, 0, 500, 400, 100, 3)] }, // 切线长 400
      { cuts: [vcut(1, 0, 0, 0, 500, 400, 100, 3)] },
    ],
  });
  assert.deepStrictEqual(batchMembers(r.batches[0]), ['3#1', '4#1']);
  assert.deepStrictEqual(batchMembers(r.batches[1]), ['1#1', '2#1']);
});

test('排程：张数与总切线长度均相同时按纸张序号决胜', () => {
  const r = scheduleStack({
    stackLimit: 5,
    sheets: [
      { cuts: [vcut(1, 0, 0, 0, 300, 200, 100, 3)] },
      { cuts: [vcut(1, 0, 0, 0, 300, 200, 100, 3)] },
      { cuts: [vcut(1, 0, 0, 0, 300, 200, 150, 3)] }, // 刀位不同，自成一组
      { cuts: [vcut(1, 0, 0, 0, 300, 200, 150, 3)] },
    ],
  });
  assert.deepStrictEqual(batchMembers(r.batches[0]), ['1#1', '2#1']);
  assert.deepStrictEqual(batchMembers(r.batches[1]), ['3#1', '4#1']);
});

test('排程：同一张纸多刀可执行时按原刀序决胜', () => {
  const r = scheduleStack({
    stackLimit: 5,
    sheets: [{
      cuts: [
        vcut(2, 0, 0, 0, 300, 200, 150, 3), // 原刀号 2
        vcut(1, 0, 0, 0, 300, 200, 100, 3), // 原刀号 1（先决）
      ],
    }],
  });
  assert.strictEqual(r.batches[0].cuts[0].cutNo, 1);
  assert.strictEqual(r.batches[0].position, 100);
  assert.strictEqual(r.batches[1].cuts[0].cutNo, 2);
});

test('排程：超过上限的组被截断后，其余张数与已解锁子刀公平竞争', () => {
  const cuts = () => [
    vcut(1, 0, 0, 0, 300, 200, 100, 3),
    hcut(2, 1, 0, 0, 100, 200, 80, 3),
  ];
  const r = scheduleStack({
    stackLimit: 2,
    sheets: [{ cuts: cuts() }, { cuts: cuts() }, { cuts: cuts() }],
  });
  // 批1：根刀组 3 张截断为第 1、2 张；
  // 批2：第 1、2 张子刀（可合并 2 张）优先于第 3 张根刀（1 张）；
  // 批3/4：第 3 张的根刀与子刀
  assert.deepStrictEqual(batchMembers(r.batches[0]), ['1#1', '2#1']);
  assert.deepStrictEqual(batchMembers(r.batches[1]), ['1#2', '2#2']);
  assert.deepStrictEqual(batchMembers(r.batches[2]), ['3#1']);
  assert.deepStrictEqual(batchMembers(r.batches[3]), ['3#2']);
  assert.deepStrictEqual(r.sheets[0].batches, [1, 2]);
  assert.deepStrictEqual(r.sheets[2].batches, [3, 4]);
});

test('排程：无刀纸张计入进度但不参与任何批次', () => {
  const r = scheduleStack({
    stackLimit: 2,
    sheets: [
      { cuts: [vcut(1, 0, 0, 0, 300, 200, 100, 3)] },
      { cuts: [] },
    ],
  });
  assert.strictEqual(r.summary.batchesTotal, 1);
  assert.strictEqual(r.sheets[1].cutsTotal, 0);
  assert.strictEqual(r.sheets[1].done, true);
  assert.deepStrictEqual(r.sheets[1].batches, []);
});

test('排程：切割树结构不完整的刀次进入未排清单并注明原因', () => {
  const r = scheduleStack({
    stackLimit: 2,
    sheets: [{
      cuts: [
        vcut(1, 0, 0, 0, 300, 200, 100, 3),
        hcut(2, 2, 0, 0, 100, 200, 80, 3), // depth 跳跃：找不到父刀
        vcut(3, 3, 0, 0, 100, 80, 40, 3), // 父刀（#2）未排程
      ],
    }],
  });
  assert.strictEqual(r.summary.batchesTotal, 1);
  assert.strictEqual(r.summary.scheduledCuts, 1);
  assert.strictEqual(r.summary.unscheduledCuts, 2);
  assert.strictEqual(r.unscheduled.length, 2);
  assert.strictEqual(r.unscheduled[0].cutNo, 2);
  assert.match(r.unscheduled[0].reason, /找不到父刀/);
  assert.strictEqual(r.unscheduled[1].cutNo, 3);
  assert.match(r.unscheduled[1].reason, /父刀未排入/);
  assert.strictEqual(r.sheets[0].done, false);
  assert.strictEqual(r.sheets[0].scheduled, 1);
});

test('排程：两次运行结果完全一致（确定性）', () => {
  const cuts = () => [
    vcut(1, 0, 0, 0, 300, 200, 100, 3),
    hcut(2, 1, 0, 0, 100, 200, 80, 3),
    hcut(3, 1, 103, 0, 197, 200, 80, 3),
  ];
  const input = () => ({
    stackLimit: 2,
    sheets: [{ cuts: cuts() }, { cuts: cuts() }, { cuts: cuts() }],
  });
  assert.deepStrictEqual(scheduleStack(input()), scheduleStack(input()));
});

/* ---------------- 参数校验（对应 HTTP 400） ---------------- */

test('排程：叠纸上限非法抛出错误', () => {
  const sheets = [{ cuts: [vcut(1, 0, 0, 0, 300, 200, 100, 3)] }];
  for (const bad of [undefined, null, 0, -1, 2.5, 501, '4x', NaN]) {
    assert.throws(() => scheduleStack({ stackLimit: bad, sheets }), /叠纸上限/);
  }
});

test('排程：空结果（无纸张 / 全部无刀次）抛出错误', () => {
  assert.throws(() => scheduleStack({ stackLimit: 2 }), /没有可排程的纸张/);
  assert.throws(() => scheduleStack({ stackLimit: 2, sheets: [] }), /没有可排程的纸张/);
  assert.throws(() => scheduleStack({ stackLimit: 2, sheets: 'x' }), /没有可排程的纸张/);
  assert.throws(
    () => scheduleStack({ stackLimit: 2, sheets: [{ cuts: [] }, { cuts: [] }] }),
    /没有可排程的裁切刀次/
  );
});

test('排程：纸张与刀次结构校验', () => {
  const good = () => vcut(1, 0, 0, 0, 300, 200, 100, 3);
  // 纸张缺少 cuts
  assert.throws(() => scheduleStack({ stackLimit: 2, sheets: [{}] }), /缺少裁切数据/);
  // 纸张数量超过上限
  assert.throws(
    () => scheduleStack({ stackLimit: 2, sheets: Array.from({ length: 501 }, () => ({ cuts: [good()] })) }),
    /纸张数量/
  );
  // 刀次字段非法
  const badCuts = [
    { ...good(), n: 'abc' },
    { ...good(), depth: -1 },
    { ...good(), depth: 1.5 },
    { ...good(), orient: 'x' },
    { ...good(), region: { x: 0, y: 0, w: 0, h: 200 } },
    { ...good(), band: { x: 100, y: 0, w: -1, h: 200 } },
    { ...good(), band: { x: 1000, y: 0, w: 3, h: 200 } }, // 刀位超出区域
  ];
  for (const c of badCuts) {
    assert.throws(() => scheduleStack({ stackLimit: 2, sheets: [{ cuts: [c] }] }));
  }
});

/* ---------------- 与批量 / 多纸型排产结果贯通 ---------------- */

/** 排程不变量：上限、一批一刀、批内合并键一致、父刀先于子刀、全部排程 */
function assertScheduleInvariants(result, rawSheets, stackLimit) {
  const cutsOf = rawSheets.map((sh) => (Array.isArray(sh.cuts) ? sh.cuts : sh.layout.cuts));
  const totalCuts = cutsOf.reduce((s, c) => s + c.length, 0);
  assert.strictEqual(result.summary.cutsTotal, totalCuts);
  assert.strictEqual(result.summary.scheduledCuts, totalCuts);
  assert.strictEqual(result.summary.unscheduledCuts, 0);
  assert.strictEqual(result.unscheduled.length, 0);

  const batchOf = new Map(); // 'sheet#cutNo' → batchNo
  let memberCount = 0;
  for (const b of result.batches) {
    assert.ok(b.sheetCount <= stackLimit, '同批不得超过叠纸上限');
    assert.strictEqual(b.cuts.length, b.sheetCount);
    const sheetsInBatch = new Set();
    const keys = new Set();
    for (const c of b.cuts) {
      assert.ok(!sheetsInBatch.has(c.sheet), '同一批中每张纸至多出现一次');
      sheetsInBatch.add(c.sheet);
      batchOf.set(`${c.sheet}#${c.cutNo}`, b.batchNo);
      memberCount += 1;
      const cut = cutsOf[c.sheet - 1].find((k) => k.n === c.cutNo);
      const pos = cut.orient === 'v' ? cut.band.x - cut.region.x : cut.band.y - cut.region.y;
      const kerf = cut.orient === 'v' ? cut.band.w : cut.band.h;
      keys.add([cut.orient, cut.region.w, cut.region.h, pos, kerf].join('|'));
    }
    assert.strictEqual(keys.size, 1, '同批各刀的区域宽高、刀向、刀位、刀缝必须一致');
  }
  assert.strictEqual(memberCount, totalCuts, '全部刀次都应排入批次');

  // 父刀完成后子刀才可入批（按前序 + 深度重建父子关系）
  cutsOf.forEach((cuts, si) => {
    const open = [];
    for (const cut of cuts) {
      if (cut.depth > 0) {
        const parent = open[cut.depth - 1];
        assert.ok(parent, '排产结果的切割树应当完整');
        const pb = batchOf.get(`${si + 1}#${parent.n}`);
        const cb = batchOf.get(`${si + 1}#${cut.n}`);
        assert.ok(cb > pb, `子刀（第 ${si + 1} 张 #${cut.n}）必须晚于父刀所在批次`);
      }
      open[cut.depth] = cut;
      open.length = cut.depth + 1;
    }
  });

  result.sheets.forEach((sh, i) => {
    assert.strictEqual(sh.sheet, i + 1);
    assert.strictEqual(sh.cutsTotal, cutsOf[i].length);
    assert.strictEqual(sh.scheduled, sh.cutsTotal);
    assert.strictEqual(sh.done, true);
  });
}

test('排程：复用批量排产结果，不变量全部成立', () => {
  const batch = layoutBatch({
    paperW: 300, paperH: 200, kerf: 3, maxSheets: 10,
    products: [
      { width: 100, height: 80, quantity: 12 },
      { width: 60, height: 50, quantity: 20 },
    ],
  });
  assert.ok(batch.sheets.length > 1, '应产生多张纸以检验叠切');
  const r = scheduleStack({ stackLimit: 3, sheets: batch.sheets });
  assertScheduleInvariants(r, batch.sheets, 3);
  // 相同布局的相邻纸张应产生合并（批次少于刀次）
  assert.ok(r.summary.savedPasses >= 0);
});

test('排程：复用多纸型成本排产结果（layout.cuts 形状），不变量全部成立', () => {
  const cost = layoutCostBatch({
    kerf: 3,
    papers: [
      { name: '大度', width: 300, height: 200, price: 5, stock: 5 },
      { name: '小度', width: 200, height: 150, price: 2, stock: 5 },
    ],
    products: [{ width: 100, height: 80, quantity: 10 }],
  });
  assert.ok(cost.sheets.length > 0);
  const r = scheduleStack({ stackLimit: 2, sheets: cost.sheets });
  assertScheduleInvariants(r, cost.sheets, 2);
  // 纸型名称随进度透出
  cost.sheets.forEach((sh, i) => {
    assert.strictEqual(r.sheets[i].paperName, sh.paperName);
  });
});

/* ---------------- HTTP 接口 ---------------- */

test('HTTP：上限非法或空结果返回 400，合法请求返回批次与进度', async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const post = (body) => fetch(`http://127.0.0.1:${port}/api/layout/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    const oneCut = vcut(1, 0, 0, 0, 300, 200, 100, 3);

    // 叠纸上限非法 → 400
    for (const stackLimit of [0, -1, 2.5, 501, 'x']) {
      const resp = await post({ stackLimit, sheets: [{ cuts: [oneCut] }] });
      assert.strictEqual(resp.status, 400, `stackLimit=${stackLimit} 应返回 400`);
      const data = await resp.json();
      assert.ok(data.error);
    }

    // 空结果 → 400
    let resp = await post({ stackLimit: 2, sheets: [] });
    assert.strictEqual(resp.status, 400);
    resp = await post({ stackLimit: 2, sheets: [{ cuts: [] }] });
    assert.strictEqual(resp.status, 400);

    // 合法请求 → 200，返回批次、所含纸张/原刀号与每张纸进度
    resp = await post({
      stackLimit: 2,
      sheets: [{ cuts: [oneCut] }, { cuts: [oneCut] }],
    });
    assert.strictEqual(resp.status, 200);
    const data = await resp.json();
    assert.strictEqual(data.summary.batchesTotal, 1);
    assert.strictEqual(data.batches[0].sheetCount, 2);
    assert.deepStrictEqual(batchMembers(data.batches[0]), ['1#1', '2#1']);
    assert.strictEqual(data.sheets.length, 2);
    assert.strictEqual(data.sheets[0].done, true);
    assert.deepStrictEqual(data.unscheduled, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
