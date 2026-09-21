'use strict';

/**
 * 叠纸裁切排程（stacked guillotine cutting schedule）
 *
 * 复用批量排产（layoutBatch）或多纸型成本排产（layoutCostBatch）的结果，
 * 把各张纸的断头台切割树转换为可按刀执行的批次（不重新排样）。
 *
 * 刀次模型与父子约束：
 *  - 每张纸的 cuts（结构同 /api/layout 返回：前序编号 n、深度 depth、
 *    刀向 orient、被切区域 region、刀缝带 band、切线长 length）按前序重建
 *    切割树：depth > 0 的刀，其父刀是其前方最近的 depth−1 刀；
 *  - 任何子刀必须等其所在纸张的父刀完成后才可入批；
 *    depth 0 的根刀首轮即可执行。
 *
 * 合并条件（同一刀次可叠纸同切，须全部一致）：
 *  - 待切区域宽高（region.w × region.h）；
 *  - 刀向（orient：v 竖切 / h 横切）；
 *  - 刀位：刀缝带起点相对被切区域左上角的位置
 *    （竖切为 band.x−region.x，横切为 band.y−region.y）；
 *  - 刀缝（竖切取 band.w，横切取 band.h）。
 *  同一批中每张纸至多出现一次（一刀只切一个位置），
 *  同批张数不超过用户设置的叠纸上限（stackLimit）。
 *
 * 排程规则（确定性）：每轮在当前可执行刀中按合并键分组，
 * 优先选择可合并张数最多的一组；平局依次按
 *   本批总切线长度（长者优先）→ 纸张序号（小者优先）→ 原刀序（小者优先）
 * 稳定决胜。一组可合并张数超过上限时按（纸张序号、原刀序）取前
 * stackLimit 张成批，其余留待后续轮次。
 *
 * 返回批次（所含纸张/原刀号）、每张纸进度与未排原因：
 * 正常排产结果的切割树必然完整，全部刀次都会排程；
 * 仅当刀次数据结构不完整（找不到父刀）时才会出现未排刀次。
 */

const MAX_SHEETS = 500; // 与批量排产用纸上限一致
const MAX_STACK = 500; // 叠纸上限（张/刀）
const MAX_CUTS = 100000; // 单次排程刀次安全阀
const EPS = 1e-6;
const POS_TOL = 0.01; // 刀位合理性容差（round3 输出的舍入噪声远小于此）

const round3 = (v) => Math.round(v * 1000) / 1000;

/** 规范化叠纸上限：必须是 1～500 的整数 */
function normalizeStackLimit(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_STACK) {
    throw new Error(`叠纸上限（stackLimit）必须是 1～${MAX_STACK} 的整数`);
  }
  return n;
}

/** 读取矩形字段 {x,y,w,h}，全部必须为有限数字 */
function readRect(value, subject) {
  if (!value || typeof value !== 'object') {
    throw new Error(`${subject}不是有效记录`);
  }
  const r = {
    x: Number(value.x),
    y: Number(value.y),
    w: Number(value.w),
    h: Number(value.h),
  };
  if (![r.x, r.y, r.w, r.h].every((n) => Number.isFinite(n))) {
    throw new Error(`${subject}的坐标或宽高不是有效数字`);
  }
  return r;
}

/**
 * 规范化一刀：校验字段并计算合并键。
 * @returns 内部刀次对象（含 key、position、kerf；parent/broken 由 linkParents 填充）
 */
function normalizeCut(raw, sheetNo, pos) {
  const subject = `第 ${sheetNo} 张纸的第 ${pos} 刀`;
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${subject}不是有效记录`);
  }
  const n = Number(raw.n);
  const depth = Number(raw.depth);
  const orient = raw.orient;
  if (!Number.isFinite(n)) {
    throw new Error(`${subject}的原刀号（n）不是有效数字`);
  }
  if (!Number.isInteger(depth) || depth < 0) {
    throw new Error(`${subject}的深度（depth）必须是非负整数`);
  }
  if (orient !== 'v' && orient !== 'h') {
    throw new Error(`${subject}的刀向（orient）必须是 v（竖切）或 h（横切）`);
  }
  const region = readRect(raw.region, `${subject}的被切区域（region）`);
  const band = readRect(raw.band, `${subject}的刀缝带（band）`);
  if (region.w <= 0 || region.h <= 0) {
    throw new Error(`${subject}的被切区域宽高必须大于 0`);
  }
  if (band.w < 0 || band.h < 0) {
    throw new Error(`${subject}的刀缝带宽高不能为负`);
  }
  // 刀位：刀缝带起点相对被切区域左上角的位置（须落在区域内，允许舍入噪声）
  const position = orient === 'v' ? band.x - region.x : band.y - region.y;
  const span = orient === 'v' ? region.w : region.h;
  if (position < -POS_TOL || position > span + POS_TOL) {
    throw new Error(`${subject}的刀位超出被切区域`);
  }
  const kerf = orient === 'v' ? band.w : band.h;
  // 切线长：优先采用排产结果给出的值，缺失时按刀缝带长度推导
  const length = Number.isFinite(Number(raw.length))
    ? Number(raw.length)
    : (orient === 'v' ? band.h : band.w);
  if (length < 0) {
    throw new Error(`${subject}的切线长不能为负`);
  }

  const cut = {
    n,
    depth,
    orient,
    region,
    band,
    length,
    kerf,
    position,
    key: [orient, round3(region.w), round3(region.h), round3(position), round3(kerf)].join('|'),
    parent: null,
    broken: false,
    done: false,
    sheetIndex: -1,
    sheetNo,
  };
  return cut;
}

/**
 * 按前序 + 深度重建切割树父子关系。
 * depth>0 的刀的父刀是其前方最近的 depth−1 刀；找不到父刀的刀标记
 * broken（结构不完整），其自身与后代都无法入批（体现在 unscheduled 中）。
 */
function linkParents(cuts) {
  const open = []; // open[d] = 深度 d 上最近出现、尚未闭合的刀
  for (const cut of cuts) {
    if (cut.depth === 0) {
      cut.parent = null;
    } else {
      const parent = open[cut.depth - 1];
      if (!parent) {
        cut.broken = true;
      } else {
        cut.parent = parent;
      }
    }
    open[cut.depth] = cut;
    open.length = cut.depth + 1;
  }
}

/**
 * 规范化一张纸：兼容批量结果（每张即单张布局，含 cuts）
 * 与成本结果（每张含 layout.cuts，并可带 paperName）。
 */
function normalizeSheet(raw, sheetNo) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`第 ${sheetNo} 张纸不是有效记录`);
  }
  const cutsRaw = Array.isArray(raw.cuts)
    ? raw.cuts
    : (raw.layout && Array.isArray(raw.layout.cuts) ? raw.layout.cuts : null);
  if (!cutsRaw) {
    throw new Error(`第 ${sheetNo} 张纸缺少裁切数据（cuts）`);
  }
  if (cutsRaw.length > MAX_CUTS) {
    throw new Error(`第 ${sheetNo} 张纸的刀次过多`);
  }
  const paperName = raw.paperName != null && String(raw.paperName).trim()
    ? String(raw.paperName).trim()
    : null;
  const cuts = cutsRaw.map((c, i) => normalizeCut(c, sheetNo, i + 1));
  linkParents(cuts);
  return { sheetNo, paperName, cuts };
}

/** 组间择优：可合并张数 ↓ → 本批总切线长度 ↓ → 纸张序号 ↑ → 原刀序 ↑ */
function betterGroup(a, b) {
  if (a.cover !== b.cover) return a.cover > b.cover;
  if (Math.abs(a.totalLength - b.totalLength) > EPS) return a.totalLength > b.totalLength;
  if (a.repSheet !== b.repSheet) return a.repSheet < b.repSheet;
  return a.repCut < b.repCut;
}

/**
 * 主入口
 * @param {object} input
 *   stackLimit: 叠纸上限（同一刀最多叠切的张数，1～500 的整数）
 *   sheets: 批量 / 多纸型排产结果的逐张数据（批量：每张含 cuts；
 *     成本：每张含 layout.cuts，可带 paperName）
 * @returns {{
 *   stackLimit: number,
 *   summary: { stackLimit, sheetsTotal, cutsTotal, scheduledCuts,
 *     unscheduledCuts, batchesTotal, savedPasses, maxStack },
 *   batches: Array,   // 逐批次：刀向/区域/刀位/刀缝/切线长/所含纸张与原刀号
 *   sheets: Array,    // 每张纸进度：刀次、已排程、涉及批次、是否完成
 *   unscheduled: Array // 未排刀次与原因（正常排产结果为空）
 * }}
 */
function scheduleStack(input) {
  const body = input || {};
  const stackLimit = normalizeStackLimit(body.stackLimit);

  const rawSheets = body.sheets;
  if (!Array.isArray(rawSheets) || rawSheets.length === 0) {
    throw new Error('没有可排程的纸张：sheets 为空（请先完成批量或多纸型排产）');
  }
  if (rawSheets.length > MAX_SHEETS) {
    throw new Error(`纸张数量不能超过 ${MAX_SHEETS}`);
  }

  const sheets = rawSheets.map((sh, i) => normalizeSheet(sh, i + 1));
  const cutsTotal = sheets.reduce((s, sh) => s + sh.cuts.length, 0);
  if (cutsTotal === 0) {
    throw new Error('没有可排程的裁切刀次：所有纸张的 cuts 均为空');
  }
  if (cutsTotal > MAX_CUTS) {
    throw new Error(`裁切刀次总数不能超过 ${MAX_CUTS}`);
  }

  // 扁平化全部刀次
  const allCuts = [];
  sheets.forEach((sh, si) => {
    for (const cut of sh.cuts) {
      cut.sheetIndex = si;
      allCuts.push(cut);
    }
  });

  const batches = [];
  let scheduledCuts = 0;

  // 每轮至少排入一刀，刀次有限，必然终止
  for (;;) {
    // 1. 收集当前可执行刀（父刀已完成），按合并键分组；
    //    每张纸在同一组内只保留原刀序最小的一刀（一批一刀一切口）
    const groups = new Map();
    for (const cut of allCuts) {
      if (cut.done || cut.broken) continue;
      if (cut.parent && !cut.parent.done) continue;
      let g = groups.get(cut.key);
      if (!g) {
        g = {
          key: cut.key,
          orient: cut.orient,
          regionW: cut.region.w,
          regionH: cut.region.h,
          position: cut.position,
          kerf: cut.kerf,
          members: new Map(), // sheetIndex → cut
        };
        groups.set(cut.key, g);
      }
      const prev = g.members.get(cut.sheetIndex);
      if (!prev || cut.n < prev.n) g.members.set(cut.sheetIndex, cut);
    }
    if (groups.size === 0) break; // 剩余刀次因父刀链断裂无法入批

    // 2. 组间择优（可合并张数 → 总切线长度 → 纸张序号 → 原刀序）
    let best = null;
    for (const g of groups.values()) {
      g.ordered = [...g.members.values()].sort((a, b) =>
        a.sheetIndex - b.sheetIndex || a.n - b.n);
      g.included = g.ordered.slice(0, stackLimit);
      g.cover = g.ordered.length;
      g.totalLength = g.included.reduce((s, c) => s + c.length, 0);
      g.repSheet = g.ordered[0].sheetIndex;
      g.repCut = g.ordered[0].n;
      if (!best || betterGroup(g, best)) best = g;
    }

    // 3. 成批：所含刀次标记完成（可能解锁各纸的子刀）
    for (const cut of best.included) {
      cut.done = true;
      scheduledCuts += 1;
    }
    batches.push({
      batchNo: batches.length + 1,
      orient: best.orient,
      region: { w: round3(best.regionW), h: round3(best.regionH) },
      position: round3(best.position),
      kerf: round3(best.kerf),
      length: round3(best.included[0].length),
      sheetCount: best.included.length,
      totalLength: round3(best.totalLength),
      cuts: best.included.map((c) => ({ sheet: c.sheetNo, cutNo: c.n, depth: c.depth })),
    });
  }

  // 未排刀次与原因：结构断裂（找不到父刀）的刀及其后代
  const unscheduled = [];
  for (const cut of allCuts) {
    if (cut.done) continue;
    unscheduled.push({
      sheet: cut.sheetNo,
      cutNo: cut.n,
      reason: cut.broken
        ? '切割树结构不完整：找不到父刀，无法确定下刀先后'
        : '父刀未排入任何批次，该子刀无法入批',
    });
  }

  // 每张纸进度
  const sheetBatches = sheets.map(() => []);
  for (const b of batches) {
    for (const c of b.cuts) sheetBatches[c.sheet - 1].push(b.batchNo);
  }
  const sheetProgress = sheets.map((sh, i) => {
    const scheduled = sh.cuts.reduce((s, c) => s + (c.done ? 1 : 0), 0);
    return {
      sheet: sh.sheetNo,
      paperName: sh.paperName,
      cutsTotal: sh.cuts.length,
      scheduled,
      done: scheduled === sh.cuts.length,
      batches: sheetBatches[i],
    };
  });

  return {
    stackLimit,
    summary: {
      stackLimit,
      sheetsTotal: sheets.length,
      cutsTotal,
      scheduledCuts,
      unscheduledCuts: unscheduled.length,
      batchesTotal: batches.length,
      // 相对逐张单刀执行（每刀一个批次）节省的刀次
      savedPasses: scheduledCuts - batches.length,
      maxStack: batches.reduce((m, b) => Math.max(m, b.sheetCount), 0),
    },
    batches,
    sheets: sheetProgress,
    unscheduled,
  };
}

module.exports = { scheduleStack, normalizeStackLimit };
