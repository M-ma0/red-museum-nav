/* ==========================================================================
   迷你 QR 编码器（字节模式 / 纠错等级 L / 版本 1–8）
   用途：在弹窗里生成"扫码在手机上打开"的二维码。
   刻意不引入任何外部库与外部请求，全部本地计算。
   ========================================================================== */
(function (global) {
  "use strict";

  /* ---- GF(256) 表 ---- */
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  /* ---- 版本参数（纠错等级 L）---- */
  var ECC_PER_BLOCK = {1: 7, 2: 10, 3: 15, 4: 20, 5: 26, 6: 18, 7: 20, 8: 24, 9: 30, 11: 20};
  var BLOCKS = {1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 2, 7: 2, 8: 2, 9: 2, 11: 4};
  var DATA_CODEWORDS = {1: 19, 2: 34, 3: 55, 4: 80, 5: 108, 6: 136, 7: 156, 8: 194, 9: 232, 11: 324};
  /* 每个版本在码字之后剩余的"余数位"（标准规定，非 8 的整数倍部分） */
  var REMAINDER_BITS = {1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0, 11: 0};
  var EC_LEVEL_BITS = 1; // 0b01 = L
  var MAX_VERSION = 11;
  var VERSION_INFO_MIN = 7; // 版本 ≥7 需要写入版本信息（ISO/IEC 18004 表 D.1）
  var VERSION_GENERATOR = 0x1f25;

  /** 6 位版本号 -> 18 位版本信息（BCH(18,6)） */
  function versionBits(version) {
    var rem = version;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * VERSION_GENERATOR);
    return ((version << 12) | (rem & 0xfff));
  }

  /** 标记版本信息占用的模块（两个 6x3 区块） */
  function markVersionInfo(mark, size, version) {
    if (version < VERSION_INFO_MIN) return;
    for (var i = 0; i < 18; i++) {
      var a = Math.floor(i / 3), b = i % 3;
      mark(size - 11 + b, a);
      mark(a, size - 11 + b);
    }
  }

  /** 写入版本信息位 */
  function writeVersionInfo(setFn, size, version) {
    if (version < VERSION_INFO_MIN) return;
    var bits = versionBits(version);
    for (var i = 0; i < 18; i++) {
      var bit = ((bits >>> i) & 1) === 1;
      var a = Math.floor(i / 3), b = i % 3;
      setFn(size - 11 + b, a, bit);
      setFn(a, size - 11 + b, bit);
    }
  }

  function sizeOf(v) { return v * 4 + 17; }
  var ALIGN_POSITIONS = {1: [], 2: [6,18], 3: [6,22], 4: [6,26], 5: [6,30], 6: [6,34], 7: [6,22,38], 8: [6,24,42], 9: [6,26,46], 10: [6,28,50], 11: [6,30,54]};
  function alignPositions(v) { return ALIGN_POSITIONS[v] || []; }
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    }
    return out;
  }

  function BitBuf() { this.bits = []; }
  BitBuf.prototype.put = function (val, n) {
    for (var i = n - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  };
  BitBuf.prototype.length = function () { return this.bits.length; };

  /** 某版本纠错等级 L 下可容纳的数据码字数 */
  function dataCapacity(version) { return DATA_CODEWORDS[version]; }

  function rsRemainder(data, degree) {
    var gen = [1];
    for (var i = 0; i < degree; i++) {
      var ng = new Array(gen.length + 1).fill(0);
      for (var j = 0; j < gen.length; j++) {
        ng[j] ^= gen[j];
        ng[j + 1] ^= gen[j] === 0 ? 0 : EXP[(LOG[gen[j]] + i) % 255];
      }
      gen = ng;
    }
    var res = new Array(degree).fill(0);
    for (var k = 0; k < data.length; k++) {
      var factor = data[k] ^ res[0];
      res.shift(); res.push(0);
      for (var m = 0; m < degree; m++) res[m] ^= factor === 0 ? 0 : EXP[(LOG[factor] + LOG[gen[m + 1]]) % 255];
    }
    return res;
  }

  /** 生成 QR 模块矩阵（true = 深色）。超出容量时返回 null */
  function encode(text) {
    var bytes = utf8Bytes(String(text));
    var version = 0;
    for (var v = 1; v <= MAX_VERSION; v++) {
      var cap = DATA_CODEWORDS[v] * 8 - 4 - (v < 10 ? 8 : 16); // 模式指示符 4 位 + 长度指示符
      if (bytes.length * 8 <= cap) { version = v; break; }
    }
    if (!version) return null;

    var totalData = DATA_CODEWORDS[version];
    var ecPerBlock = ECC_PER_BLOCK[version];
    var blocks = BLOCKS[version];
    var dataPerBlock = totalData / blocks;

    /* --- 位流 --- */
    var bb = new BitBuf();
    bb.put(0x4, 4);                    // 字节模式
    bb.put(bytes.length, version < 10 ? 8 : 16);   // 长度指示符（版本 ≥10 为 16 位）
    for (var i = 0; i < bytes.length; i++) bb.put(bytes[i], 8);
    var capBits = totalData * 8;
    // 终止符：最多 4 个 0，且不得超出容量
    bb.put(0, Math.max(0, Math.min(4, capBits - bb.length())));
    // 补齐到字节边界（不超过容量）
    while (bb.length() % 8 !== 0 && bb.length() < capBits) bb.put(0, 1);
    // 交替填充字节 0xEC / 0x11
    var pads = [0xec, 0x11], pi = 0;
    while (bb.length() + 8 <= capBits) bb.put(pads[pi++ % 2], 8);

    /* --- 码字 --- */
    var cw = [];
    for (var b = 0; b < bb.length(); b += 8) {
      var byteVal = 0;
      for (var k = 0; k < 8; k++) byteVal = (byteVal << 1) | bb.bits[b + k];
      cw.push(byteVal);
    }

    /* --- 分块 + 纠错 --- */
    var dataBlocks = [], ecBlocks = [];
    for (var bi = 0; bi < blocks; bi++) {
      var chunk = cw.slice(bi * dataPerBlock, (bi + 1) * dataPerBlock);
      dataBlocks.push(chunk);
      ecBlocks.push(rsRemainder(chunk, ecPerBlock));
    }
    var finalCw = [];
    for (var ci = 0; ci < dataPerBlock; ci++) for (var bj = 0; bj < blocks; bj++) finalCw.push(dataBlocks[bj][ci]);
    for (var ei = 0; ei < ecPerBlock; ei++) for (var bk = 0; bk < blocks; bk++) finalCw.push(ecBlocks[bk][ei]);

    /* --- 矩阵 --- */
    var size = sizeOf(version);
    var mat = [], res = [], i2, j2;
    for (i2 = 0; i2 < size; i2++) {
      mat.push(new Array(size).fill(false));
      res.push(new Array(size).fill(false));
    }
    function setF(r, c, val) { if (r < 0 || c < 0 || r >= size || c >= size) return; mat[r][c] = val; res[r][c] = true; }

    /* 定位图形 + 分隔符 */
    [[0, 0], [0, size - 7], [size - 7, 0]].forEach(function (p) {
      for (var r = -1; r <= 7; r++) for (var c = -1; c <= 7; c++) {
        var rr = p[0] + r, cc = p[1] + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        var inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
        var inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setF(rr, cc, inRing || inCore);
      }
    });

    /* 校正图形 */
    var ap = alignPositions(version);
    for (var a = 0; a < ap.length; a++) for (var b2 = 0; b2 < ap.length; b2++) {
      var ar = ap[a], ac = ap[b2];
      if (res[ar][ac]) continue;
      for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++) {
        var edge = Math.max(Math.abs(dr), Math.abs(dc));
        setF(ar + dr, ac + dc, edge !== 1);
      }
    }

    /* 定位（时序）图形 */
    for (var t = 8; t < size - 8; t++) {
      if (!res[6][t]) setF(6, t, t % 2 === 0);
      if (!res[t][6]) setF(t, 6, t % 2 === 0);
    }

    /* 固定深色模块 */
    setF(size - 8, 8, true);

    /* 预留格式信息区 */
    for (var f = 0; f <= 8; f++) {
      if (!res[8][f]) setF(8, f, false);
      if (!res[f][8]) setF(f, 8, false);
    }
    for (var g = 0; g < 8; g++) {
      if (!res[8][size - 1 - g]) setF(8, size - 1 - g, false);
      if (!res[size - 1 - g][8]) setF(size - 1 - g, 8, false);
    }
    /* 预留版本信息区（版本 ≥7） */
    markVersionInfo(function (r, c) { setF(r, c, false); }, size, version);

    /* 数据填充（之字形） */
    var bitIdx = 0, upward = true;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (var s = 0; s < size; s++) {
        var row = upward ? size - 1 - s : s;
        for (var cstep = 0; cstep < 2; cstep++) {
          var cc2 = col - cstep;
          if (res[row][cc2]) continue;
          var bit = false;
          if (bitIdx < finalCw.length * 8) {
            bit = ((finalCw[bitIdx >> 3] >>> (7 - (bitIdx & 7))) & 1) === 1;
            bitIdx++;
          }
          mat[row][cc2] = bit;
        }
      }
      upward = !upward;
    }

    /* 掩码 + 格式信息 */
    function maskFn(m, r, c) {
      switch (m) {
        case 0: return (r + c) % 2 === 0;
        case 1: return r % 2 === 0;
        case 2: return c % 3 === 0;
        case 3: return (r + c) % 3 === 0;
        case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
        case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
        case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
        case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
      }
      return false;
    }
    function formatBits(mask) {
      var data = (EC_LEVEL_BITS << 3) | mask;
      var rem = data;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
    }
    function applyFormat(m, sz, bits) {
      function put(r, c, i) {
        if (r < 0 || c < 0 || r >= sz || c >= sz) return;
        m[r][c] = ((bits >>> i) & 1) === 1;
      }
      for (var i = 0; i <= 5; i++) put(8, i, i);
      put(8, 7, 6); put(8, 8, 7); put(7, 8, 8);
      for (var j = 9; j <= 14; j++) put(14 - j, 8, j);
      for (var k = 0; k <= 7; k++) put(sz - 1 - k, 8, k);
      for (var l = 8; l <= 14; l++) put(8, sz - 15 + l, l);
    }

    var best = null;
    for (var mask = 0; mask < 8; mask++) {
      var m2 = mat.map(function (r) { return r.slice(); });
      for (var r2 = 0; r2 < size; r2++) for (var c3 = 0; c3 < size; c3++) {
        if (!res[r2][c3] && maskFn(mask, r2, c3)) m2[r2][c3] = !m2[r2][c3];
      }
      applyFormat(m2, size, formatBits(mask));
      writeVersionInfo(function (r, c, v) { m2[r][c] = v; }, size, version);
      var pen = penalty(m2, size);
      if (!best || pen < best.pen) best = { pen: pen, mat: m2, mask: mask };
    }
    return { version: version, size: size, matrix: best.mat, mask: best.mask };
  }

  function penalty(m, size) {
    var p = 0, r, c, i;
    /* 规则1：同色连续 5 个以上 */
    for (r = 0; r < size; r++) {
      var run = 1;
      for (c = 1; c < size; c++) {
        if (m[r][c] === m[r][c - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p += 1; }
        else run = 1;
      }
    }
    for (c = 0; c < size; c++) {
      var run2 = 1;
      for (r = 1; r < size; r++) {
        if (m[r][c] === m[r - 1][c]) { run2++; if (run2 === 5) p += 3; else if (run2 > 5) p += 1; }
        else run2 = 1;
      }
    }
    /* 规则2：2x2 同色块 */
    for (r = 0; r < size - 1; r++) for (c = 0; c < size - 1; c++) {
      var v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
    }
    /* 规则3：类定位图形 */
    var pat1 = [true, false, true, true, true, false, true, false, false, false, false];
    var pat2 = [false, false, false, false, true, false, true, true, true, false, true];
    function match(arr, off, pat) {
      for (var k = 0; k < pat.length; k++) if (arr[off + k] !== pat[k]) return false;
      return true;
    }
    for (r = 0; r < size; r++) {
      var row = m[r];
      for (c = 0; c + 11 <= size; c++) { if (match(row, c, pat1) || match(row, c, pat2)) p += 40; }
    }
    for (c = 0; c < size; c++) {
      var colArr = [];
      for (r = 0; r < size; r++) colArr.push(m[r][c]);
      for (r = 0; r + 11 <= size; r++) { if (match(colArr, r, pat1) || match(colArr, r, pat2)) p += 40; }
    }
    /* 规则4：深色比例偏离 50% */
    var dark = 0;
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) if (m[r][c]) dark++;
    var ratio = (dark * 100) / (size * size);
    p += Math.floor(Math.abs(ratio - 50) / 5) * 10;
    return p;
  }

  /** 渲染成 canvas（dataURL）；scale 为每个模块的像素数 */
  function toCanvas(qr, scale) {
    scale = scale || 6;
    var quiet = 4, size = qr.size, px = (size + quiet * 2) * scale;
    var cv = document.createElement("canvas");
    cv.width = cv.height = px;
    var ctx = cv.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = "#14161a";
    for (var r = 0; r < size; r++) for (var c = 0; c < size; c++) {
      if (qr.matrix[r][c]) {
        ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
    return cv;
  }

  /* ---- 自检：用独立不变式验证编码器 ----
     1) 格式信息 BCH 必须与 QR 规范公布的 15 位表一致
     2) Reed-Solomon 的数学不变式：生成多项式必须整除 (数据·x^deg + 余数)
     3) 数据容量必须等于矩阵可用模块数（确保之字形填充与预留区正确）
  */
  var FORMAT_TABLE = {
    0: 0x77c4, 1: 0x72f3, 2: 0x7daa, 3: 0x789d,
    4: 0x662f, 5: 0x6318, 6: 0x6c41, 7: 0x6976
  };

  function gfMulArr(a, b) {
    var out = new Array(a.length + b.length - 1).fill(0);
    for (var i = 0; i < a.length; i++) {
      if (!a[i]) continue;
      for (var j = 0; j < b.length; j++) {
        if (!b[j]) continue;
        out[i + j] ^= EXP[(LOG[a[i]] + LOG[b[j]]) % 255];
      }
    }
    return out;
  }

  function generatorPoly(degree) {
    var g = [1];
    for (var i = 0; i < degree; i++) g = gfMulArr(g, [1, EXP[i]]);
    return g;
  }

  /** 用生成多项式除 (data·x^deg + ec)，验证余数为 0 */
  function rsPropertyHolds(data, ec, degree) {
    var poly = data.concat(ec);
    var g = generatorPoly(degree);
    // 多项式长除法
    var buf = poly.slice();
    for (var i = 0; i < data.length; i++) {
      var coef = buf[i];
      if (!coef) continue;
      var lc = LOG[coef];
      for (var j = 0; j < g.length; j++) {
        if (g[j]) buf[i + j] ^= EXP[(lc + LOG[g[j]]) % 255];
      }
    }
    for (var k = data.length; k < buf.length; k++) if (buf[k] !== 0) return false;
    return true;
  }

  function selfTest() {
    var degree = 13;
    var gen = generatorPoly(degree);

    // (1) 格式信息
    var fmtOk = true, fmtGot = {};
    for (var mask = 0; mask < 8; mask++) {
      var data = (EC_LEVEL_BITS << 3) | mask, rem = data;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var bits = ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
      fmtGot[mask] = bits;
      if (bits !== FORMAT_TABLE[mask]) fmtOk = false;
    }

    // (2) RS 不变式
    var msg = "HELLO WORLD";
    var bb = new BitBuf();
    bb.put(0x4, 4);
    bb.put(msg.length, 8);
    for (var c = 0; c < msg.length; c++) bb.put(msg.charCodeAt(c), 8);
    while (bb.length() % 8 !== 0) bb.put(0, 1);
    var pads = [0xec, 0x11], pi = 0;
    while (bb.length() < 104) bb.put(pads[pi++ % 2], 8);
    var cw = [];
    for (var b = 0; b < bb.length(); b += 8) {
      var byteVal = 0;
      for (var k = 0; k < 8; k++) byteVal = (byteVal << 1) | bb.bits[b + k];
      cw.push(byteVal);
    }
    var ec = rsRemainder(cw, degree);
    var rsOk = cw.length === 13 && rsPropertyHolds(cw, ec, degree);

    // (3) 容量一致性：可用模块数 == 码字总位数 + 余数位（跳过本实现未收录的版本）
    var capOk = true, capDetail = [];
    for (var v = 1; v <= MAX_VERSION; v++) {
      if (DATA_CODEWORDS[v] === undefined) continue;
      var available = (sizeOf(v) * sizeOf(v)) - reservedCount(v);
      var need = (DATA_CODEWORDS[v] + ECC_PER_BLOCK[v] * BLOCKS[v]) * 8 + REMAINDER_BITS[v];
      capDetail.push({ v: v, available: available, need: need, ok: available === need });
      if (available !== need) capOk = false;
    }

    // (4) 端到端：编码后用独立解码器读回，且 8 种掩码中只有真实掩码能还原原文
    var decOk = true, decDetail = {};
    ["A", "https://a.cn/", "https://720yun.com/t/e4vkOh19sim?scene_id=57965262",
     "https://baike.baidu.com/item/圣地延安数字博物馆群/23449705",
     "x".repeat(DATA_CODEWORDS[8] - 3)].forEach(function (s) {
      var q = encode(s);
      var hits = 0;
      if (q) {
        for (var m = 0; m < 8; m++) {
          var got = null;
          try { got = decodeWithMask(q, m); } catch (e) { got = null; }
          if (got === s) hits++;
        }
      }
      var ok = hits === 1;
      decDetail["len" + s.length] = ok ? "ok" : "hits=" + hits;
      if (!ok) decOk = false;
    });
    // 超长必须安全返回 null，而不是抛错
    if (encode("x".repeat(400)) !== null) decOk = false;

    return { fmtOk: fmtOk, rsOk: rsOk, capOk: capOk, decOk: decOk,
             ok: fmtOk && rsOk && capOk && decOk,
             fmtGot: fmtGot, cw: cw, ec: ec, gen: gen, capDetail: capDetail, decDetail: decDetail };
  }

  /** 从矩阵按指定掩码读回码字数组（用于自检诊断） */
  function decodeBitStream(qr, mask) {
    var size = qr.size, version = qr.version;
    var res = [];
    for (var i = 0; i < size; i++) res.push(new Array(size).fill(false));
    function mark(r, c) { if (r >= 0 && c >= 0 && r < size && c < size) res[r][c] = true; }
    [[0, 0], [0, size - 7], [size - 7, 0]].forEach(function (p) {
      for (var r = -1; r <= 7; r++) for (var c = -1; c <= 7; c++) mark(p[0] + r, p[1] + c);
    });
    var ap = alignPositions(version);
    for (var a = 0; a < ap.length; a++) for (var b = 0; b < ap.length; b++) {
      var ar = ap[a], ac = ap[b];
      if (res[ar][ac]) continue;
      for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++) mark(ar + dr, ac + dc);
    }
    for (var t = 8; t < size - 8; t++) { mark(6, t); mark(t, 6); }
    for (var f = 0; f <= 8; f++) { mark(8, f); mark(f, 8); }
    for (var g = 0; g < 8; g++) { mark(8, size - 1 - g); mark(size - 1 - g, 8); }
    markVersionInfo(mark, size, version);
    var out = [], upward = true;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (var s = 0; s < size; s++) {
        var row = upward ? size - 1 - s : s;
        for (var cstep = 0; cstep < 2; cstep++) {
          var cc = col - cstep;
          if (res[row][cc]) continue;
          var v = qr.matrix[row][cc];
          if (maskFn(mask, row, cc)) v = !v;
          out.push(v ? 1 : 0);
        }
      }
      upward = !upward;
    }
    var cw = [];
    for (var p = 0; p + 8 <= out.length; p += 8) {
      var byteVal = 0;
      for (var q = 0; q < 8; q++) byteVal = (byteVal << 1) | out[p + q];
      cw.push(byteVal);
    }
    return cw;
  }

  function maskFn(m, r, c) {
    switch (m) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
    return false;
  }

  /** 独立解码器：读回码字、按块反交织、还原字节模式字符串（用于端到端自检） */
  function decodeWithMask(qr, mask) {
    var interleaved = decodeBitStream(qr, mask);
    var version = qr.version;
    var totalData = DATA_CODEWORDS[version];
    var ecPerBlock = ECC_PER_BLOCK[version];
    var blocks = BLOCKS[version];
    var dataPerBlock = totalData / blocks;

    // 反交织：数据部分按块轮流取，随后是各块的纠错码字
    var dataBlocks = [], b;
    for (b = 0; b < blocks; b++) dataBlocks.push([]);
    for (var i = 0; i < dataPerBlock; i++) {
      for (b = 0; b < blocks; b++) {
        var v = interleaved[i * blocks + b];
        if (v === undefined) return null;
        dataBlocks[b].push(v);
      }
    }
    var cw = [];
    for (b = 0; b < blocks; b++) cw = cw.concat(dataBlocks[b]);

    var total = cw.length * 8;
    function bit(i) {
      if (i < 0 || i >= total) return 0;
      return (cw[i >> 3] >> (7 - (i & 7))) & 1;
    }
    // 解析字节模式：模式 4 位 + 长度 8 位
    var p = 0, mode = 0, k;
    for (k = 0; k < 4; k++) mode = (mode << 1) | bit(p++);
    if (mode !== 4) return null;
    var lenBits = version < 10 ? 8 : 16;
    var len = 0;
    for (k = 0; k < lenBits; k++) len = (len << 1) | bit(p++);
    if (len > cw.length) return null;
    var dataBytes = [];
    for (var n = 0; n < len; n++) {
      var bv = 0;
      for (k = 0; k < 8; k++) bv = (bv << 1) | bit(p++);
      dataBytes.push(bv);
    }
    // UTF-8 还原
    var str = "";
    for (var i2 = 0; i2 < dataBytes.length;) {
      var b0 = dataBytes[i2];
      if (b0 < 0x80) { str += String.fromCharCode(b0); i2 += 1; }
      else if (b0 < 0xe0) { str += String.fromCharCode(((b0 & 0x1f) << 6) | (dataBytes[i2 + 1] & 63)); i2 += 2; }
      else if (b0 < 0xf0) {
        str += String.fromCharCode(((b0 & 0x0f) << 12) | ((dataBytes[i2 + 1] & 63) << 6) | (dataBytes[i2 + 2] & 63));
        i2 += 3;
      } else {
        var cp = ((b0 & 0x07) << 18) | ((dataBytes[i2 + 1] & 63) << 12) | ((dataBytes[i2 + 2] & 63) << 6) | (dataBytes[i2 + 3] & 63);
        cp -= 0x10000;
        str += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        i2 += 4;
      }
    }
    return str;
  }

  /** 尝试全部 8 种掩码，返回唯一匹配的原文（用于端到端验证） */
  function decodeRoundTrip(qr, original) {
    for (var m = 0; m < 8; m++) {
      var s = null;
      try { s = decodeWithMask(qr, m); } catch (e) { s = null; }
      if (s === original) return true;
    }
    return false;
  }

  /** 独立统计各版本被功能图形占用的模块数 */
  var _reservedCache = {};
  function reservedCount(version) {
    if (_reservedCache[version]) return _reservedCache[version];
    var size = sizeOf(version);
    var res = [];
    for (var i = 0; i < size; i++) res.push(new Array(size).fill(false));
    function mark(r, c) { if (r >= 0 && c >= 0 && r < size && c < size) res[r][c] = true; }
    [[0, 0], [0, size - 7], [size - 7, 0]].forEach(function (p) {
      for (var r = -1; r <= 7; r++) for (var c = -1; c <= 7; c++) mark(p[0] + r, p[1] + c);
    });
    var ap = alignPositions(version);
    for (var a = 0; a < ap.length; a++) for (var b = 0; b < ap.length; b++) {
      var ar = ap[a], ac = ap[b];
      if (res[ar][ac]) continue;
      for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++) mark(ar + dr, ac + dc);
    }
    for (var t = 8; t < size - 8; t++) { mark(6, t); mark(t, 6); }
    for (var f = 0; f <= 8; f++) { mark(8, f); mark(f, 8); }
    for (var g = 0; g < 8; g++) { mark(8, size - 1 - g); mark(size - 1 - g, 8); }
    markVersionInfo(mark, size, version);
    var n = 0;
    for (var r2 = 0; r2 < size; r2++) for (var c2 = 0; c2 < size; c2++) if (res[r2][c2]) n++;
    _reservedCache[version] = n;
    return n;
  }

  global.RMQr = { encode: encode, toCanvas: toCanvas, selfTest: selfTest };
})(window);
