(() => {
  document.documentElement.dataset.tbGptProductionExtension = "ready";
  const DEFAULT_API_ROOT = "http://127.0.0.1:4327";
  const ROOT_ID = "tb-gpt-production-studio";
  const LAUNCHER_ID = "tb-gpt-production-launcher";
  const DROP_OVERLAY_ID = "tb-gpt-production-drop-overlay";
  const EMBEDDED_STORAGE_KEY = "tb-workbench-embedded";
  const API_ROOT_STORAGE_KEY = "tb-workbench-api-root";
  const PATH_STORAGE_KEY = "tb-production-paths";
  const ACTION_STORAGE_KEY = "tb-material-action-settings";
  const SEASON_TAGS = Object.freeze({
    春季: ["春季", "春天", "春日"],
    夏季: ["夏季", "夏天", "夏日", "夏季团建"],
    秋季: ["秋季", "秋天", "秋日"],
    冬季: ["冬季", "冬天", "冬日"]
  });
  const HOLIDAY_TAGS = Object.freeze({
    元旦: ["元旦", "跨年"],
    春节: ["春节", "过年", "除夕"],
    元宵节: ["元宵节", "元宵"],
    情人节: ["情人节"],
    妇女节: ["妇女节", "女神节", "三八"],
    清明节: ["清明节", "清明"],
    劳动节: ["劳动节", "五一"],
    青年节: ["青年节", "五四"],
    儿童节: ["儿童节", "六一"],
    端午节: ["端午节", "端午"],
    七夕: ["七夕"],
    中秋节: ["中秋节", "中秋"],
    重阳节: ["重阳节", "重阳"],
    国庆节: ["国庆节", "国庆"],
    圣诞节: ["圣诞节", "圣诞"]
  });
  const DEFAULT_ACTION_SETTINGS = Object.freeze({
    game: { enabled: true, label: "游戏" },
    conversion: { enabled: true, label: "转化" },
    guide: { enabled: true, label: "合集" },
    increment: { enabled: true, label: "+1" },
    move: { enabled: false, label: "收纳", targetPath: "" }
  });
  const DEFAULT_PATHS = Object.freeze({
    productRoot: "D:\\AICode\\项目推进\\projects\\江湖有旅人\\主项目\\成品库（GPT+本地脚本制作）",
    materialRoot: "D:\\AICode\\项目推进\\projects\\江湖有旅人\\主项目\\01-素材库"
  });
  const state = {
    workspace: null,
    materials: null,
    materialIndex: null,
    paths: { ...DEFAULT_PATHS },
    productTree: null,
    productChildren: {},
    openProducts: new Set(),
    openMaterials: new Set(),
    materialFilter: { mainTag: "全部", season: "全部", holiday: "全部", usage: "all", query: "" },
    actionSettings: JSON.parse(JSON.stringify(DEFAULT_ACTION_SETTINGS)),
    settingsOpen: false,
    busy: false,
    uploadTasks: [],
    uploadSequence: 0,
    health: {
      local: false,
      gptUpload: false,
      dedup: false
    },
    connected: false,
    collapsed: false,
    dragging: null,
    moveTarget: null,
    pendingMove: null,
    pendingUsage: null,
    usageCommitTimer: null
  };
  let remountQueued = false;
  let refreshTimer = null;
  let materialIndexTimer = null;
  localStorage.removeItem("tb-studio-collapsed");

  function isEmbeddedWorkbench() {
    return localStorage.getItem(EMBEDDED_STORAGE_KEY) === "1"
      || /TeambuildingWorkbenchGPT/i.test(navigator.userAgent || "");
  }

  function currentApiRoot() {
    const candidate = String(localStorage.getItem(API_ROOT_STORAGE_KEY) || "").trim();
    return /^http:\/\/127\.0\.0\.1:\d+$/.test(candidate) ? candidate : DEFAULT_API_ROOT;
  }

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
  const fileName = (filePath) => String(filePath || "").split(/[\\/]/).pop() || "本地文件";

  function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  async function directLocalRequest(pathname, options = {}, responseType = "json", signal = null) {
    const response = await fetch(new URL(pathname, currentApiRoot()).href, {
      method: options.method || "GET",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body,
      signal
    });
    if (!response.ok) throw new Error(await response.text().catch(() => `HTTP ${response.status}`));
    const contentType = response.headers.get("content-type") || "";
    if (responseType === "base64") return { ok: true, contentType, data: bufferToBase64(await response.arrayBuffer()) };
    if (responseType === "text") return { ok: true, contentType, data: await response.text() };
    return { ok: true, contentType, data: await response.json() };
  }

  async function api(pathname, options = {}) {
    if (isEmbeddedWorkbench()) {
      const result = await directLocalRequest(pathname, options);
      return result.data;
    }
    const result = await chrome.runtime.sendMessage({
      type: "tb-local-request",
      baseUrl: currentApiRoot(),
      path: pathname,
      method: options.method || "GET",
      body: options.body ? JSON.parse(options.body) : undefined
    });
    if (!result?.ok) throw new Error(result?.error || "本地工作台连接失败");
    return result.data;
  }

  async function readLocalFile(filePath, responseType = "base64", signal = null) {
    if (isEmbeddedWorkbench()) {
      return directLocalRequest(`/file?path=${encodeURIComponent(filePath)}`, {}, responseType, signal);
    }
    if (signal?.aborted) throw new DOMException("上传已取消", "AbortError");
    const request = chrome.runtime.sendMessage({
      type: "tb-local-request",
      baseUrl: currentApiRoot(),
      path: `/file?path=${encodeURIComponent(filePath)}`,
      responseType
    });
    const abort = new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("上传已取消", "AbortError")), { once: true });
    });
    const result = signal ? await Promise.race([request, abort]) : await request;
    if (!result?.ok) throw new Error(result?.error || `无法读取 ${fileName(filePath)}`);
    return result;
  }

  function readStoredPaths() {
    return new Promise((resolve) => {
      chrome.storage.local.get(PATH_STORAGE_KEY, (result) => {
        const saved = result?.[PATH_STORAGE_KEY] || {};
        resolve({
          productRoot: saved.productRoot || DEFAULT_PATHS.productRoot,
          materialRoot: saved.materialRoot || DEFAULT_PATHS.materialRoot
        });
      });
    });
  }

  function storePaths(paths = state.paths) {
    const next = {
      productRoot: paths.productRoot || DEFAULT_PATHS.productRoot,
      materialRoot: paths.materialRoot || DEFAULT_PATHS.materialRoot
    };
    state.paths = next;
    chrome.storage.local.set({ [PATH_STORAGE_KEY]: next });
  }

  function normalizeActionSettings(raw = {}) {
    return Object.fromEntries(Object.entries(DEFAULT_ACTION_SETTINGS).map(([key, defaults]) => {
      const saved = raw?.[key] || {};
      return [key, {
        ...defaults,
        enabled: saved.enabled !== undefined ? Boolean(saved.enabled) : defaults.enabled,
        label: String(saved.label || defaults.label).trim().slice(0, 8) || defaults.label,
        ...(key === "move" ? { targetPath: String(saved.targetPath || "").trim() } : {})
      }];
    }));
  }

  function readActionSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(ACTION_STORAGE_KEY, (result) => {
        resolve(normalizeActionSettings(result?.[ACTION_STORAGE_KEY] || {}));
      });
    });
  }

  function storeActionSettings(settings = state.actionSettings) {
    state.actionSettings = normalizeActionSettings(settings);
    chrome.storage.local.set({ [ACTION_STORAGE_KEY]: state.actionSettings });
  }

  function setStatus(message, tone = "") {
    const node = document.querySelector(`#${ROOT_ID} [data-status]`);
    if (!node) return;
    node.textContent = message;
    node.dataset.tone = tone;
  }

  function setBusy(entry, message = "") {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    root.dataset.busy = String(Boolean(entry));
    root.querySelectorAll("[data-entry-kind]").forEach((row) => {
      row.classList.toggle("is-uploading", Boolean(entry) && row.dataset.entryId === entry.id);
    });
    if (message) setStatus(message);
  }

  function renderHealth() {
    const host = document.querySelector(`#${ROOT_ID} [data-health]`);
    if (!host) return;
    const checks = [
      ["local", "本地目录"],
      ["gptUpload", "GPT 上传"],
      ["dedup", "历史去重"]
    ];
    host.innerHTML = checks.map(([key, label]) => (
      `<i data-ok="${String(Boolean(state.health[key]))}" title="${label}${state.health[key] ? "正常" : "未就绪"}"></i>`
    )).join("");
    host.title = checks.map(([key, label]) => `${label}：${state.health[key] ? "正常" : "未就绪"}`).join("\n");
  }

  function renderQueue() {
    const host = document.querySelector(`#${ROOT_ID} [data-upload-queue]`);
    if (!host) return;
    const tasks = state.uploadTasks.slice(-4).reverse();
    host.hidden = tasks.length === 0;
    host.innerHTML = tasks.map((task) => {
      const progress = task.total
        ? Math.min(100, Math.round((task.completed / task.total) * 100))
        : 0;
      const label = {
        queued: "等待上传",
        checking: "检查历史去重",
        reading: `读取 ${task.completed}/${task.total}`,
        attaching: "放入 GPT",
        success: "已进入附件区",
        duplicate: "已拦截重复",
        failed: "上传失败",
        cancelled: "已取消"
      }[task.status] || task.status;
      return `
        <article class="tb-queue-row" data-queue-status="${escapeHtml(task.status)}">
          <div class="tb-queue-copy">
            <b title="${escapeHtml(task.entry.name)}">${escapeHtml(task.entry.name)}</b>
            <small>${escapeHtml(label)}${task.error ? ` · ${escapeHtml(task.error)}` : ""}</small>
          </div>
          <div class="tb-queue-progress"><i style="width:${progress}%"></i></div>
          ${["queued", "checking", "reading"].includes(task.status)
            ? `<button type="button" data-cancel-upload="${task.id}">取消</button>`
            : task.status === "failed"
              ? `<button type="button" data-retry-upload="${task.id}">重试</button>`
              : `<span class="tb-queue-result">${task.status === "success" ? "✓" : "—"}</span>`}
        </article>
      `;
    }).join("");
  }

  function scheduleRefresh(delay) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, delay);
  }

  function applyLayout() {
    document.documentElement.classList.toggle("tb-production-studio-open", !state.collapsed);
    const root = document.getElementById(ROOT_ID);
    if (root) root.dataset.collapsed = String(state.collapsed);
    const launcher = document.getElementById(LAUNCHER_ID);
    if (launcher) launcher.hidden = !state.collapsed;
  }

  function showDropOverlay(visible) {
    const overlay = document.getElementById(DROP_OVERLAY_ID);
    if (overlay) overlay.hidden = !visible;
  }

  function isChatDropTarget(target) {
    return Boolean(
      target?.closest?.("main")
      && !target.closest?.(`#${ROOT_ID}`)
      && !target.closest?.("nav, aside, [role='navigation']")
    );
  }

  function clearMoveTarget() {
    document.querySelectorAll(`#${ROOT_ID} .is-move-target`)
      .forEach((node) => node.classList.remove("is-move-target"));
    state.moveTarget = null;
  }

  function renderMoveDialog() {
    const dialog = document.querySelector(`#${ROOT_ID} [data-move-dialog]`);
    if (!dialog) return;
    const pending = state.pendingMove;
    dialog.hidden = !pending;
    if (!pending) return;
    dialog.querySelector("[data-move-source-name]").textContent = pending.entry.name;
    dialog.querySelector("[data-move-target-name]").textContent = fileName(pending.targetPath);
  }

  async function confirmMove() {
    const pending = state.pendingMove;
    if (!pending) return;
    state.pendingMove = null;
    renderMoveDialog();
    setStatus(`正在移动“${pending.entry.name}”…`);
    try {
      await api("/api/extension/move-entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourcePath: pending.entry.path,
          targetPath: pending.targetPath
        })
      });
      state.productChildren = {};
      state.openProducts.clear();
      state.openMaterials.clear();
      await refresh();
      setStatus(`已移动到“${fileName(pending.targetPath)}”`, "success");
    } catch (error) {
      setStatus(`移动失败：${error.message}`, "danger");
    }
  }

  function productRows(entries = state.productTree?.entries || [], depth = 0) {
    return entries.map((item) => {
      if (item.kind === "file") {
        return `
          <article class="tb-work-row tb-file-row" style="--tree-depth:${depth}" draggable="${item.uploadable ? "true" : "false"}"
            ${item.uploadable ? `data-entry-kind="product" data-entry-id="${escapeHtml(item.id)}"` : ""}>
            <span class="tb-file-icon" aria-hidden="true"></span>
            <span class="tb-work-name" title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</span>
            ${item.uploadable ? `<button type="button" data-upload-product="${escapeHtml(item.id)}">传 GPT</button>` : ""}
          </article>
        `;
      }
      const loaded = Object.prototype.hasOwnProperty.call(state.productChildren, item.path);
      const children = state.productChildren[item.path]?.entries || [];
      const directCount = Number(item.imageCount || 0) + Number(item.textCount || 0);
      return `
          <details class="tb-tree-group tb-product-group" style="--tree-depth:${depth}" data-product-path="${escapeHtml(item.path)}"
            ${state.openProducts.has(item.path) ? "open" : ""}>
          <summary draggable="true" data-move-source-kind="product" data-move-source-id="${escapeHtml(item.id)}"
            data-move-target-path="${escapeHtml(item.path)}">
            <span class="tb-folder-icon"></span>
            <span class="tb-library-copy">
              <b title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</b>
              <small>${Number(item.folderCount || 0)} 个文件夹 · ${Number(item.fileCount || 0)} 个文件</small>
            </span>
            <span class="tb-library-count">${Number(item.folderCount || 0) + Number(item.fileCount || 0)}</span>
          </summary>
          <div class="tb-tree-items">
            ${directCount ? `
              <article class="tb-work-row tb-folder-upload" draggable="true" data-entry-kind="product" data-entry-id="${escapeHtml(item.id)}"
                data-move-source-kind="product" data-move-source-id="${escapeHtml(item.id)}">
                <span class="tb-image-count"><b>${Number(item.imageCount || 0)}</b><small>图</small></span>
                <span class="tb-work-copy"><span class="tb-work-name">上传这个文件夹</span><small>${Number(item.textCount || 0)} 个文档</small></span>
                <button type="button" data-upload-product="${escapeHtml(item.id)}">传 GPT</button>
              </article>
            ` : ""}
            ${loaded ? productRows(children, depth + 1) || `<div class="tb-empty compact">这个文件夹是空的</div>`
              : `<div class="tb-empty compact">展开后读取这个文件夹</div>`}
          </div>
        </details>
      `;
    }).join("") || `<div class="tb-empty">成品目录是空的</div>`;
  }

  function materialMatchesFilter(item) {
    const { mainTag, season, holiday, usage, query } = state.materialFilter;
    if (mainTag !== "全部" && item.mainTag !== mainTag) return false;
    if (season !== "全部" && !materialHasGroupedTag(item, SEASON_TAGS, season)) return false;
    if (holiday !== "全部" && !materialHasGroupedTag(item, HOLIDAY_TAGS, holiday)) return false;
    const count = Number(item.usageCount || 0);
    if (usage === "0" && count !== 0) return false;
    if (usage === "1" && count !== 1) return false;
    if (usage === "2" && count !== 2) return false;
    if (usage === "3+" && count < 3) return false;
    const needle = String(query || "").trim().toLowerCase();
    if (needle) {
      const haystack = `${item.name || ""} ${item.mainTag || ""} ${(item.tags || []).join(" ")} ${item.folderHash || ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  }

  function materialHasGroupedTag(item, groups, value) {
    const aliases = groups[value] || [];
    const tags = new Set((item.tags || []).map((tag) => String(tag).trim()));
    return aliases.some((alias) => tags.has(alias));
  }

  function groupedTagCounts(groups) {
    const items = state.materialIndex?.items || [];
    return Object.fromEntries(Object.keys(groups).map((value) => [
      value,
      items.filter((item) => materialHasGroupedTag(item, groups, value)).length
    ]));
  }

  function materialActionButtons(item) {
    const settings = state.actionSettings;
    const buttons = [];
    if (settings.game.enabled) buttons.push(`<button type="button" data-material-main-tag="团建游戏" data-material-id="${escapeHtml(item.id)}">${escapeHtml(settings.game.label)}</button>`);
    if (settings.conversion.enabled) buttons.push(`<button type="button" data-material-main-tag="团建转化" data-material-id="${escapeHtml(item.id)}">${escapeHtml(settings.conversion.label)}</button>`);
    if (settings.guide.enabled) buttons.push(`<button type="button" data-material-main-tag="合集攻略" data-material-id="${escapeHtml(item.id)}">${escapeHtml(settings.guide.label)}</button>`);
    if (settings.increment.enabled) buttons.push(`<button type="button" data-material-increment="${escapeHtml(item.id)}">${escapeHtml(settings.increment.label)}</button>`);
    if (settings.move.enabled && settings.move.targetPath) buttons.push(`<button type="button" data-material-move="${escapeHtml(item.id)}">${escapeHtml(settings.move.label)}</button>`);
    return buttons.join("");
  }

  function materialRow(item, indexed = false) {
    return `
      <article class="tb-work-row" draggable="${indexed ? "false" : "true"}"
        data-entry-kind="material" data-entry-id="${escapeHtml(item.id)}"
        data-index-category="${escapeHtml(item.categoryId || "")}"
        data-indexed="${String(indexed)}"
        data-move-source-kind="material" data-move-source-id="${escapeHtml(item.id)}">
        <span class="tb-post-folder" aria-hidden="true"><i class="tb-folder-icon"></i></span>
        <span class="tb-work-copy">
          <span class="tb-work-name" title="${escapeHtml(item.path || item.name)}">${escapeHtml(item.name)}</span>
          <span class="tb-material-meta"><i>${escapeHtml(item.mainTag || "团建转化")}</i><em>${Number(item.usageCount || 0)} 次</em><code title="文件夹哈希 ${escapeHtml(item.folderHash || "")}">${escapeHtml((item.folderHash || "").slice(0, 8))}</code></span>
          <small>${Number(item.imageCount || 0)} 张图 · ${Number(item.textCount || 0)} 个文档${item.mainTagSource === "manual" ? " · 人工标签" : " · 自动识别"}${item.usageSource ? ` · ${escapeHtml(item.usageSource)}` : ""}</small>
        </span>
        <span class="tb-material-actions">${materialActionButtons(item)}<button type="button" class="tb-primary-action" data-upload-material="${escapeHtml(item.id)}" data-index-category="${escapeHtml(item.categoryId || "")}">传 GPT</button></span>
      </article>`;
  }

  function materialFilterActive() {
    return state.materialFilter.mainTag !== "全部"
      || state.materialFilter.season !== "全部"
      || state.materialFilter.holiday !== "全部"
      || state.materialFilter.usage !== "all"
      || Boolean(String(state.materialFilter.query || "").trim());
  }

  function globalMaterialRows() {
    const index = state.materialIndex;
    if (!index?.items?.length) {
      const progress = index?.status === "running"
        ? `正在建立全库索引：${Number(index.processedCategories || 0)}/${Number(index.totalCategories || 0)} 个分类，已识别 ${Number(index.indexedItems || 0)} 条`
        : "全库索引尚未完成";
      return `<div class="tb-empty">${progress}</div>`;
    }
    const filtered = index.items.filter(materialMatchesFilter);
    const visible = filtered
      .slice()
      .sort((left, right) => Number(right.usageCount || 0) - Number(left.usageCount || 0)
        || String(left.name || "").localeCompare(String(right.name || ""), "zh-Hans-CN"))
      .slice(0, 240);
    const groups = new Map();
    visible.forEach((item) => {
      const key = item.categoryId || item.categoryName || "其他";
      if (!groups.has(key)) groups.set(key, { id: key, name: item.categoryName || "其他", items: [] });
      groups.get(key).items.push(item);
    });
    const rows = Array.from(groups.values()).map((category) => `
      <details class="tb-tree-group tb-index-results" open>
        <summary><span class="tb-folder-icon"></span><b>${escapeHtml(category.name)}</b><small>${category.items.length}</small></summary>
        <div class="tb-tree-items">${category.items.map((item) => materialRow(item, true)).join("")}</div>
      </details>
    `).join("");
    if (!rows) return `<div class="tb-empty">全库筛选下没有匹配素材</div>`;
    return `<div class="tb-index-result-note">全库匹配 ${filtered.length} 条${filtered.length > visible.length ? `，当前显示前 ${visible.length} 条，请继续输入关键词缩小范围` : ""}</div>${rows}`;
  }

  function materialRows() {
    if (materialFilterActive()) return globalMaterialRows();
    const categories = state.materials?.categories || [];
    return categories.map((category) => `
      <details class="tb-tree-group" data-category="${escapeHtml(category.id)}"
        ${state.openMaterials.has(category.id) ? "open" : ""}>
        <summary data-move-target-path="${escapeHtml(category.path)}"><span class="tb-folder-icon"></span><b title="${escapeHtml(category.name)}">${escapeHtml(category.name)}</b><small>${Number(category.count || 0)}</small></summary>
        <div class="tb-tree-items">
          ${category.loaded ? (category.items || []).map((item) => materialRow(item)).join("")
            || `<div class="tb-empty compact">这个分类没有素材</div>`
            : `<div class="tb-empty compact">展开后读取这个文件夹并生成哈希</div>`}
        </div>
      </details>
    `).join("") || `<div class="tb-empty">素材目录中还没有识别到“图片 + 文案”帖子</div>`;
  }

  function materialFilterBar() {
    const stats = state.materialIndex?.stats;
    const tagButtons = ["全部", "团建游戏", "团建转化", "合集攻略"].map((tag) => (
      `<button type="button" data-filter-main-tag="${tag}" data-active="${String(state.materialFilter.mainTag === tag)}">${tag}<small>${tag === "全部" ? Number(stats?.total || 0) : Number(stats?.byMainTag?.[tag] || 0)}</small></button>`
    )).join("");
    const seasonCounts = groupedTagCounts(SEASON_TAGS);
    const holidayCounts = groupedTagCounts(HOLIDAY_TAGS);
    const groupedButtons = (dimension, groups, counts) => ["全部", ...Object.keys(groups)]
      .filter((value) => value === "全部" || Number(counts[value] || 0) > 0)
      .map((value) => `<button type="button" data-filter-dimension="${dimension}" data-filter-value="${value}" data-active="${String(state.materialFilter[dimension] === value)}">${value}<small>${value === "全部" ? "" : Number(counts[value] || 0)}</small></button>`)
      .join("");
    const progress = state.materialIndex?.status === "running"
      ? `索引 ${Number(state.materialIndex.processedCategories || 0)}/${Number(state.materialIndex.totalCategories || 0)}`
      : state.materialIndex?.generatedAt
        ? `已索引 ${Number(stats?.total || 0)} · 待核对 ${Number(stats?.review || 0)}`
        : "准备建立全库索引";
    return `
      <div class="tb-material-filter">
        <div class="tb-main-filter-row">${tagButtons}</div>
        <div class="tb-filter-dimensions">
          <details class="tb-filter-group" ${state.materialFilter.season !== "全部" ? "open" : ""}>
            <summary>季节${state.materialFilter.season !== "全部" ? ` · ${escapeHtml(state.materialFilter.season)}` : ""}</summary>
            <div>${groupedButtons("season", SEASON_TAGS, seasonCounts)}</div>
          </details>
          <details class="tb-filter-group" ${state.materialFilter.holiday !== "全部" ? "open" : ""}>
            <summary>节日${state.materialFilter.holiday !== "全部" ? ` · ${escapeHtml(state.materialFilter.holiday)}` : ""}</summary>
            <div>${groupedButtons("holiday", HOLIDAY_TAGS, holidayCounts)}</div>
          </details>
        </div>
        <select data-filter-usage aria-label="按使用次数筛选">
          <option value="all" ${state.materialFilter.usage === "all" ? "selected" : ""}>全部次数 ${Number(stats?.total || 0)}</option>
          <option value="0" ${state.materialFilter.usage === "0" ? "selected" : ""}>未使用 ${Number(stats?.byUsage?.unused || 0)}</option>
          <option value="1" ${state.materialFilter.usage === "1" ? "selected" : ""}>使用 1 次 ${Number(stats?.byUsage?.once || 0)}</option>
          <option value="2" ${state.materialFilter.usage === "2" ? "selected" : ""}>使用 2 次 ${Number(stats?.byUsage?.twice || 0)}</option>
          <option value="3+" ${state.materialFilter.usage === "3+" ? "selected" : ""}>使用 3 次以上 ${Number(stats?.byUsage?.threePlus || 0)}</option>
        </select>
        <input data-filter-query value="${escapeHtml(state.materialFilter.query)}" placeholder="搜索名称、标签或哈希">
        <button type="button" data-open-material-settings title="设置文件夹按钮">⚙</button>
        <small class="tb-index-status">${progress}</small>
      </div>`;
  }

  function materialSettingsFields() {
    const rows = [
      ["game", "团建游戏"],
      ["conversion", "团建转化"],
      ["guide", "合集攻略"],
      ["increment", "使用次数 +1"],
      ["move", "移动到固定目录"]
    ];
    return rows.map(([key, title]) => {
      const setting = state.actionSettings[key];
      return `<label class="tb-setting-row">
        <input type="checkbox" data-action-enabled="${key}" ${setting.enabled ? "checked" : ""}>
        <span>${title}</span>
        <input data-action-label="${key}" value="${escapeHtml(setting.label)}" maxlength="8" aria-label="${title}按钮名称">
      </label>`;
    }).join("");
  }

  function renderMaterialSettings() {
    const root = document.getElementById(ROOT_ID);
    const dialog = root?.querySelector("[data-material-settings]");
    if (!dialog) return;
    dialog.hidden = !state.settingsOpen;
    if (!state.settingsOpen) return;
    dialog.querySelector("[data-action-fields]").innerHTML = materialSettingsFields();
    dialog.querySelector("[data-action-move-target]").value = state.actionSettings.move.targetPath || "";
  }

  function renderBody() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    const settings = state.workspace?.settings;
    const production = state.workspace?.dedup?.production;
    root.querySelector("[data-product-path]").value = settings?.workPackage?.libraryPath || state.paths.productRoot;
    root.querySelector("[data-material-path]").value = settings?.materialRoot || state.paths.materialRoot;
    root.querySelector("[data-dedup]").innerHTML = production?.available
      ? `<b>${Number(production.uniqueImageGroups || 0)}</b> 组历史 · 精确 ${Number(production.exactHashGroups || 0)} · 视觉 ${Number(production.perceptualHashGroups || 0)}`
      : "历史去重库尚未连接";
    root.querySelector("[data-products]").innerHTML = productRows();
    root.querySelector("[data-material-filter]").innerHTML = materialFilterBar();
    root.querySelector("[data-materials]").innerHTML = materialRows();
    renderMaterialSettings();
  }

  function render() {
    const host = document.body || document.documentElement;
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement("aside");
      root.id = ROOT_ID;
      root.innerHTML = `
        <header class="tb-studio-header">
          <div><span>本地生产</span><b>团建创作</b></div>
          <button type="button" data-collapse title="收起右侧生产舱">×</button>
        </header>
        <form class="tb-path-bar" data-product-form>
          <label>成品库</label>
          <input data-product-path aria-label="成品库路径" placeholder="粘贴成品文件夹路径，回车读取">
          <button type="submit">读取</button>
        </form>
        <div class="tb-dedup-strip"><i></i><span data-dedup>正在读取历史去重库…</span></div>
        <section class="tb-studio-zone tb-products-zone">
          <div class="tb-zone-title"><div><span>01</span><b>成品区</b></div><small>成品包与已完成作品</small></div>
          <div class="tb-zone-scroll" data-products></div>
        </section>
        <section class="tb-studio-zone tb-materials-zone">
          <div class="tb-zone-title"><div><span>02</span><b>素材区</b></div><small>图片 + 文案帖子</small></div>
          <form class="tb-mini-path" data-material-form>
            <input data-material-path aria-label="素材库路径" placeholder="粘贴素材文件夹路径">
            <button type="submit" title="读取素材目录">↻</button>
          </form>
          <div data-material-filter></div>
          <div class="tb-zone-scroll" data-materials></div>
        </section>
        <section class="tb-upload-queue" data-upload-queue hidden></section>
        <section class="tb-move-confirm" data-move-dialog hidden role="dialog" aria-modal="true" aria-label="确认移动文件夹">
          <div>
            <b>移动本地文件夹？</b>
            <p>“<span data-move-source-name></span>”将真实移动到“<span data-move-target-name></span>”。原位置会消失。</p>
            <footer>
              <button type="button" data-cancel-move>取消</button>
              <button type="button" data-confirm-move>确认移动</button>
            </footer>
          </div>
        </section>
        <section class="tb-material-settings" data-material-settings hidden role="dialog" aria-modal="true" aria-label="素材文件夹按钮设置">
          <form data-material-settings-form>
            <header><b>素材文件夹按钮</b><button type="button" data-close-material-settings aria-label="关闭设置">×</button></header>
            <p>每个文件夹只保留一个母标签；同义游戏分类统一归入“团建游戏”。</p>
            <div data-action-fields></div>
            <label class="tb-move-target"><span>固定移动目录</span><input data-action-move-target placeholder="例如 D:\\素材库\\已处理"></label>
            <footer><button type="button" data-reset-material-settings>恢复默认</button><button type="submit">保存设置</button></footer>
          </form>
        </section>
        <footer class="tb-studio-footer"><span data-status>正在连接本地工作台…</span><span class="tb-health" data-health></span><b>拖入对话或点“传 GPT”</b></footer>
      `;
      host.appendChild(root);
      root.querySelector("[data-product-path]").value = state.paths.productRoot;
      root.querySelector("[data-material-path]").value = state.paths.materialRoot;
    }
    let launcher = document.getElementById(LAUNCHER_ID);
    if (!launcher) {
      launcher = document.createElement("button");
      launcher.id = LAUNCHER_ID;
      launcher.className = "tb-studio-reopen";
      launcher.type = "button";
      launcher.dataset.studioLauncher = "";
      launcher.title = "展开团建创作生产舱";
      launcher.setAttribute("aria-label", "展开团建创作生产舱");
      launcher.innerHTML = `<span>创作舱</span><b>‹</b>`;
      host.appendChild(launcher);
    }
    let dropOverlay = document.getElementById(DROP_OVERLAY_ID);
    if (!dropOverlay) {
      dropOverlay = document.createElement("div");
      dropOverlay.id = DROP_OVERLAY_ID;
      dropOverlay.hidden = true;
      dropOverlay.innerHTML = "<b>松开放入当前 GPT</b><span>将自动读取文件、上传附件并填入生产指令</span>";
      host.appendChild(dropOverlay);
    }
    applyLayout();
    if (state.workspace) renderBody();
    renderQueue();
    renderHealth();
  }

  function composer() {
    return document.querySelector("#prompt-textarea")
      || document.querySelector('textarea[placeholder*="Message"]')
      || document.querySelector('form [data-lexical-editor="true"][contenteditable="true"]')
      || document.querySelector('[data-testid*="composer"] [contenteditable="true"]');
  }

  function mergeComposerText(existing, addition) {
    const current = String(existing || "");
    if (!current.trim()) return addition;
    if (current.includes(addition)) return current;
    return `${current.replace(/\s+$/, "")}\n\n${addition}`;
  }

  function fillComposer(text) {
    const target = composer();
    if (!target) throw new Error("没有找到当前 GPT 输入框");
    target.focus();
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      const existingText = target.value || "";
      const nextText = mergeComposerText(existingText, text);
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), "value")?.set;
      if (setter) setter.call(target, nextText);
      else target.value = nextText;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    const existingText = target.innerText || target.textContent || "";
    const nextText = mergeComposerText(existingText, text);
    const addition = existingText.trim() ? `\n\n${text}` : text;
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (typeof document.execCommand === "function") {
      document.execCommand("insertText", false, addition);
    } else {
      target.textContent = nextText;
    }
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: addition }));
  }

  function waitFor(check, timeout = 4000) {
    const started = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        const value = check();
        if (value || Date.now() - started > timeout) return resolve(value || null);
        setTimeout(tick, 90);
      };
      tick();
    });
  }

  async function findFileInput() {
    const locate = () => document.querySelector('#upload-files:not(:disabled)')
      || document.querySelector('input[data-testid="upload-files-input"]:not(:disabled)');
    const existing = locate();
    if (existing) return existing;
    const attachmentButton = [...document.querySelectorAll("button")].find((button) => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.title || ""}`;
      return /attach|add (?:photos|files)|upload|附件|添加文件|上传/i.test(label) && !button.disabled;
    });
    attachmentButton?.click();
    return waitFor(locate, 2500);
  }

  function attachmentPreviewCount() {
    const scope = document.querySelector("main");
    if (!scope) return 0;
    return new Set([
      ...scope.querySelectorAll('[data-testid*="attachment"]'),
      ...scope.querySelectorAll('button[aria-label*="Remove attachment"], button[aria-label*="移除附件"]')
    ]).size;
  }

  async function loadFiles(paths, task) {
    const files = [];
    task.status = "reading";
    task.total = paths.length;
    task.completed = 0;
    renderQueue();
    for (let index = 0; index < paths.length; index += 1) {
      if (task.controller.signal.aborted) throw new DOMException("上传已取消", "AbortError");
      setStatus(`正在读取 ${index + 1}/${paths.length}`);
      const response = await readLocalFile(paths[index], "base64", task.controller.signal);
      const binary = atob(response.data);
      const bytes = new Uint8Array(binary.length);
      for (let byteIndex = 0; byteIndex < binary.length; byteIndex += 1) {
        bytes[byteIndex] = binary.charCodeAt(byteIndex);
      }
      const blob = new Blob([bytes], { type: response.contentType || "application/octet-stream" });
      files.push(new File([blob], fileName(paths[index]), { type: blob.type || "application/octet-stream" }));
      task.completed = index + 1;
      renderQueue();
    }
    return files;
  }

  function instruction(entry) {
    if (entry.customPrompt) return String(entry.customPrompt);
    return [
      "请按当前对话已经确定的母版和网页脚本处理这份团建内容。",
      `本地文件夹：${entry.path}`,
      `内容名称：${entry.name}`,
      `素材图片：${entry.imageCount || 0} 张`,
      "",
      "请先读取刚上传的图片与 TXT，再继续当前对话中的既定流程。"
    ].join("\n");
  }

  async function checkEntryDuplicate(entry, task) {
    const textPath = (entry.attachments || []).find((filePath) => /\.(txt|md)$/i.test(filePath));
    if (!textPath) return null;
    task.status = "checking";
    renderQueue();
    const source = await readLocalFile(textPath, "text", task.controller.signal);
    const text = source.data;
    if (!text.trim()) return null;
    return api("/api/dedup/check-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
  }

  async function checkMaterialUsage(entry, task) {
    if (entry.entryKind !== "material") return null;
    task.status = "checking";
    renderQueue();
    return api("/api/extension/material-usage-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryPath: entry.path })
    });
  }

  async function recordMaterialUsage(entry, status) {
    if (entry.entryKind !== "material") return null;
    const payload = await api("/api/extension/material-use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entryPath: entry.path,
        name: entry.name,
        status,
        conversationUrl: location.href
      })
    });
    entry.usage = payload.record;
    if (status === "used") {
      entry.usageCount = Math.max(0, Number(entry.usageCount || 0)) + 1;
      entry.usageSource = "历史日志 + 扩展实时记录";
      const indexed = (state.materialIndex?.items || []).find((item) => item.id === entry.id);
      if (indexed && indexed !== entry) {
        indexed.usageCount = entry.usageCount;
        indexed.usageSource = entry.usageSource;
      }
      recalculateLocalIndexStats();
    }
    renderBody();
    return payload.record;
  }

  function composerContainsEntry(entry) {
    const target = composer();
    const value = target?.value || target?.innerText || target?.textContent || "";
    return Boolean(entry && value && (value.includes(entry.path) || value.includes(entry.name)));
  }

  function commitPendingMaterialUsage() {
    const entry = state.pendingUsage;
    if (!entry || !composerContainsEntry(entry)) return;
    clearTimeout(state.usageCommitTimer);
    state.usageCommitTimer = setTimeout(async () => {
      try {
        await recordMaterialUsage(entry, "used");
        state.pendingUsage = null;
        setStatus(`已登记使用：${entry.name}`, "success");
      } catch (error) {
        setStatus(`素材已发送，但台账登记失败：${error.message}`, "danger");
      }
    }, 700);
  }

  function reportWorkbenchTask(task, status, detail = "") {
    const requestId = task?.entry?.externalRequestId;
    if (!requestId) return;
    document.documentElement.dataset.tbGptLastTask = `${requestId}:${status}`;
    const result = {
      source: "tb-gpt-production-extension",
      type: "tb-workbench-task-result",
      requestId,
      status,
      detail: String(detail || "")
    };
    let bridge = document.getElementById("tb-workbench-bridge-result");
    if (!bridge) {
      bridge = document.createElement("script");
      bridge.id = "tb-workbench-bridge-result";
      bridge.type = "application/json";
      document.documentElement.appendChild(bridge);
    }
    bridge.textContent = JSON.stringify(result);
    document.dispatchEvent(new Event("tb-workbench-task-result"));
    window.postMessage(result, "*");
  }

  function reportWorkbenchProgress(task, stage, percent, detail = "") {
    const requestId = task?.entry?.externalRequestId;
    if (!requestId) return;
    const result = {
      source: "tb-gpt-production-extension",
      type: "tb-workbench-task-progress",
      requestId,
      stage: String(stage || ""),
      percent: Math.max(0, Math.min(100, Number(percent || 0))),
      detail: String(detail || "")
    };
    let bridge = document.getElementById("tb-workbench-bridge-progress");
    if (!bridge) {
      bridge = document.createElement("script");
      bridge.id = "tb-workbench-bridge-progress";
      bridge.type = "application/json";
      document.documentElement.appendChild(bridge);
    }
    bridge.textContent = JSON.stringify(result);
    document.dispatchEvent(new Event("tb-workbench-task-progress"));
    window.postMessage(result, "*");
  }

  function assistantTurns() {
    return [...document.querySelectorAll(
      '[data-message-author-role="assistant"], article[data-turn="assistant"], [data-testid^="conversation-turn"]'
    )].filter((turn) => {
      const role = turn.getAttribute("data-message-author-role");
      if (role) return role === "assistant";
      return !turn.querySelector('[data-message-author-role="user"]');
    });
  }

  function generatingNow() {
    return [...document.querySelectorAll("button")].some((button) => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.title || ""} ${button.textContent || ""}`;
      return /stop generating|stop streaming|停止生成|停止回答/i.test(label);
    });
  }

  function platformPauseReason() {
    if (/\/auth\/(?:login|signup)|\/login(?:[/?#]|$)/i.test(location.href)) {
      return "GPT 登录状态已失效，请重新登录后继续";
    }
    const visibleAlerts = [...document.querySelectorAll(
      '[role="alert"], [role="dialog"], [data-sonner-toast], [data-testid*="modal"], [data-testid*="dialog"]'
    )].filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const message = visibleAlerts.map((node) => String(node.innerText || node.textContent || "")).join("\n");
    if (/too many requests|rate limit|usage limit|try again later|请求过多|达到.*上限|稍后再试/i.test(message)) {
      return "GPT 当前出现频率或额度限制，队列已暂停";
    }
    if (/verify you are human|security check|验证码|安全验证|完成验证/i.test(message)) {
      return "GPT 需要完成登录或安全验证，队列已暂停";
    }
    return "";
  }

  function sendButton() {
    const target = composer();
    const scope = target?.closest("form") || target?.parentElement || document;
    return scope.querySelector('#composer-submit-button:not(:disabled), [data-testid="send-button"]:not(:disabled)')
      || [...scope.querySelectorAll("button:not(:disabled)")].find((button) => {
        const label = `${button.getAttribute("aria-label") || ""} ${button.title || ""} ${button.getAttribute("data-testid") || ""}`;
        return /send|submit|发送|提交/i.test(label);
      });
  }

  async function submitComposer() {
    const target = composer();
    if (!target) throw new Error("没有找到当前 GPT 输入框");
    const button = await waitFor(() => sendButton(), 5000);
    if (button) {
      button.click();
      return true;
    }
    target.focus();
    target.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true
    }));
    return true;
  }

  function turnSignature(turns = []) {
    return turns.map((turn) => {
      const text = String(turn.innerText || turn.textContent || "").trim();
      return `${text.length}:${turn.querySelectorAll("img").length}`;
    }).join("|");
  }

  async function waitForAssistantCompletion(beforeCount, options = {}) {
    const timeout = Math.max(30_000, Number(options.timeout || 15 * 60_000));
    const needImages = Boolean(options.needImages);
    const started = Date.now();
    let stableSince = 0;
    let lastSignature = "";
    while (Date.now() - started < timeout) {
      const pauseReason = platformPauseReason();
      if (pauseReason) throw new Error(pauseReason);
      const turns = assistantTurns();
      const freshTurns = turns.slice(beforeCount);
      const signature = turnSignature(freshTurns);
      const imageCount = freshTurns.reduce((sum, turn) => sum + turn.querySelectorAll("img").length, 0);
      const hasContent = freshTurns.length > 0 && freshTurns.some((turn) =>
        String(turn.innerText || turn.textContent || "").trim().length > 20 || turn.querySelector("img")
      );
      if (signature && signature === lastSignature && !generatingNow()) {
        if (!stableSince) stableSince = Date.now();
      } else {
        stableSince = 0;
        lastSignature = signature;
      }
      if (hasContent && (!needImages || imageCount > 0) && stableSince && Date.now() - stableSince >= 10_000) {
        return { turns: freshTurns, imageCount };
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(needImages ? "等待套图完成超时，尚未检测到稳定图片结果" : "等待 GPT 回复完成超时");
  }

  function workPackageBatchId() {
    const now = new Date();
    const digits = (value) => String(value).padStart(2, "0");
    const stamp = `${now.getFullYear()}${digits(now.getMonth() + 1)}${digits(now.getDate())}-${digits(now.getHours())}${digits(now.getMinutes())}${digits(now.getSeconds())}`;
    return `${stamp}-${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
  }

  function imageUrl(image) {
    if (!image) return "";
    const candidate = String(image.currentSrc || image.src || image.getAttribute?.("src") || "").trim();
    if (!/^(?:https?:|blob:|data:image\/)/i.test(candidate)) return "";
    if (/data:image\/svg/i.test(candidate)) return "";
    const width = Number(image.naturalWidth || image.width || image.getBoundingClientRect?.().width || 0);
    const height = Number(image.naturalHeight || image.height || image.getBoundingClientRect?.().height || 0);
    if (width && height && (width < 160 || height < 160)) return "";
    return candidate;
  }

  function freshImageUrls(turns) {
    const buttons = [...new Set(turns.flatMap((turn) => [
      ...turn.querySelectorAll(".cgpt-conversation-tree-image-download-all")
    ]))];
    const images = buttons.flatMap((button) => {
      if (Array.isArray(button.__cgptImageDownloadImages)) return button.__cgptImageDownloadImages;
      const container = button.__cgptImageDownloadContainer
        || button.closest("[data-cgpt-image-download-container]")
        || button.closest('[data-message-author-role="assistant"]')
        || button.parentElement;
      return container ? [...container.querySelectorAll("img")] : [];
    });
    if (!images.length) images.push(...turns.flatMap((turn) => [...turn.querySelectorAll("img")]));
    return [...new Set(images.map(imageUrl).filter(Boolean))];
  }

  function downloadThroughExtension(url, filename, requestId, timeout = 5 * 60_000) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const finish = (callback, value) => {
        if (timer) clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(onMessage);
        callback(value);
      };
      const onMessage = (message) => {
        if (message?.type !== "tb-download-status" || message.requestId !== requestId) return;
        if (message.status === "complete") finish(resolve, message.filename || filename);
        if (message.status === "error") finish(reject, new Error(message.error || "图片下载失败"));
      };
      chrome.runtime.onMessage.addListener(onMessage);
      timer = setTimeout(() => finish(reject, new Error(`图片下载超时：${filename}`)), timeout);
      chrome.runtime.sendMessage({
        type: "tb-download",
        url,
        filename,
        requestId,
        baseUrl: API_ROOT
      }).then((result) => {
        if (!result?.ok) finish(reject, new Error(result?.error || "无法启动图片下载"));
      }).catch((error) => finish(reject, error));
    });
  }

  async function downloadFreshImages(turns, task) {
    reportWorkbenchProgress(task, "下载图片", 68, "正在核对本轮新生成图片");
    const urls = freshImageUrls(turns);
    if (!urls.length) throw new Error("检测到生成结果，但没有找到本轮可下载图片");
    const batchId = workPackageBatchId();
    const files = [];
    for (let index = 0; index < urls.length; index += 1) {
      const url = urls[index];
      const extensionMatch = url.match(/\.(png|jpe?g|webp|gif|avif)(?:[?#]|$)/i);
      const extension = extensionMatch ? extensionMatch[1].toLowerCase().replace("jpeg", "jpg") : "png";
      const filename = `chatgpt-workpkg-${batchId}-${index + 1}-of-${urls.length}.${extension}`;
      const requestId = `${task.entry.externalRequestId || batchId}-image-${index + 1}`;
      reportWorkbenchProgress(task, "下载图片", 68 + Math.round(index / urls.length * 8), `正在下载 ${index + 1}/${urls.length}`);
      files.push(await downloadThroughExtension(url, filename, requestId));
    }
    if (files.length !== urls.length) throw new Error(`图片下载不完整：${files.length}/${urls.length}`);
    return { count: files.length, batchId, files };
  }

  function cleanAssistantText(turn) {
    if (!turn) return "";
    const clone = turn.cloneNode(true);
    clone.querySelectorAll("button, svg, img, [aria-hidden='true'], .cgpt-conversation-tree-image-download-slot, .cgpt-conversation-tree-text-download-slot")
      .forEach((node) => node.remove());
    return String(clone.innerText || clone.textContent || "")
      .replace(/^\s*(ChatGPT|助手)\s*/i, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  async function runAutomaticProduction(task) {
    const options = task.entry.autoOptions || {};
    const taskTimeout = Math.max(5, Number(options.taskTimeoutMinutes || 30)) * 60_000;
    const initialAssistantCount = assistantTurns().length;
    reportWorkbenchProgress(task, "提交迁移计划", 18, "附件完成，正在发送母版迁移要求");
    await submitComposer();
    await waitForAssistantCompletion(initialAssistantCount, { timeout: Math.min(taskTimeout, 8 * 60_000) });
    if (options.autoConfirm === false) {
      reportWorkbenchProgress(task, "等待人工确认", 30, "迁移计划已完成，自动发送 1 已关闭");
      return { plannedOnly: true };
    }

    const beforeImagesCount = assistantTurns().length;
    reportWorkbenchProgress(task, "确认出图", 36, "迁移计划已完成，自动发送 1");
    fillComposer("1");
    await submitComposer();
    const imageResult = await waitForAssistantCompletion(beforeImagesCount, {
      timeout: taskTimeout,
      needImages: true
    });
    const downloadResult = await downloadFreshImages(imageResult.turns, task);
    const downloadedImages = downloadResult.count;
    if (!downloadedImages) throw new Error("图片下载数量为 0，未执行打包");
    if (options.autoCopy === false) {
      reportWorkbenchProgress(task, "完成", 100, `已下载 ${downloadedImages} 张图；自动文案已关闭`);
      return { downloadedImages, textSkipped: true };
    }

    const beforeTextCount = assistantTurns().length;
    reportWorkbenchProgress(task, "生成小红书文案", 78, "图片已下载，正在请求本帖文案");
    fillComposer("给我一份小红书文案");
    await submitComposer();
    const textResult = await waitForAssistantCompletion(beforeTextCount, { timeout: 8 * 60_000 });
    const copyText = cleanAssistantText(textResult.turns[textResult.turns.length - 1]);
    if (copyText.length < 80) throw new Error("没有检测到完整的小红书文案，未执行打包");
    await navigator.clipboard.writeText(copyText);

    reportWorkbenchProgress(task, "打包作品", 92, `已下载 ${downloadedImages} 张图，正在写入 TXT 并打包`);
    if (options.autoPackage === false) {
      reportWorkbenchProgress(task, "完成", 100, `已下载 ${downloadedImages} 张图并复制文案；自动打包已关闭`);
      return { downloadedImages, copyText, packageSkipped: true };
    }
    const packageResult = await api("/api/extension/work-package", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clipboardText: copyText,
        title: task.entry.name,
        conversationUrl: location.href,
        accountName: localStorage.getItem("tb-workbench-account-id") || "",
        batchId: downloadResult.batchId,
        expectedImageCount: downloadedImages
      })
    });
    if (!packageResult?.ok) throw new Error(packageResult?.error || "本地打包没有返回成功");
    reportWorkbenchProgress(task, "完成", 100, `已打包 ${downloadedImages} 张图片和小红书文案`);
    return { downloadedImages, packageResult };
  }

  function uploadEntry(entry) {
    if (!entry) return;
    const duplicate = state.uploadTasks.find((task) =>
      task.entry.id === entry.id && ["queued", "reading", "attaching"].includes(task.status)
    );
    if (duplicate) {
      setStatus("这个文件夹已经在上传队列中");
      return;
    }
    state.uploadSequence += 1;
    state.uploadTasks.push({
      id: state.uploadSequence,
      entry,
      status: "queued",
      total: (entry.attachments || []).slice(0, 30).length,
      completed: 0,
      error: "",
      controller: new AbortController()
    });
    if (state.uploadTasks.length > 12) state.uploadTasks.splice(0, state.uploadTasks.length - 12);
    renderQueue();
    setStatus(`已加入上传队列：${entry.name}`);
    processUploadQueue();
  }

  async function processUploadQueue() {
    if (state.busy) return;
    const task = state.uploadTasks.find((item) => item.status === "queued");
    if (!task) return;
    state.busy = true;
    const { entry } = task;
    setBusy(entry, `正在准备“${entry.name}”的文件…`);
    try {
      const paths = (entry.attachments || []).slice(0, 30);
      if (!paths.length) throw new Error("这个文件夹里没有可上传的图片或文案");
      const usage = await checkMaterialUsage(entry, task);
      if (usage?.duplicate) {
        task.status = "duplicate";
        task.error = usage.match === "fingerprint"
          ? "内容指纹与已使用素材一致（即使文件夹改过名字）"
          : "这个素材已经使用过";
        entry.usage = usage.record;
        renderBody();
        renderQueue();
        setStatus(`已拦截重复素材：${entry.name}`, "danger");
        return;
      }
      const duplicate = await checkEntryDuplicate(entry, task);
      if (duplicate?.duplicate) {
        task.status = "duplicate";
        task.error = `历史中已存在${duplicate.record?.title ? `：${duplicate.record.title}` : ""}`;
        renderQueue();
        setStatus(`已拦截重复内容：${entry.name}`, "danger");
        return;
      }
      const [files, input] = await Promise.all([loadFiles(paths, task), findFileInput()]);
      if (task.controller.signal.aborted) throw new DOMException("上传已取消", "AbortError");
      if (!input) throw new Error("当前 GPT 没有原生附件入口，请先点输入框旁的“+”再重试");
      task.status = "attaching";
      renderQueue();
      const previewsBefore = attachmentPreviewCount();
      const transfer = new DataTransfer();
      files.forEach((file) => transfer.items.add(file));
      input.files = transfer.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      if (input.files.length !== files.length) throw new Error("文件没有成功进入 ChatGPT 附件入口");
      const appeared = await waitFor(() => {
        const first = files[0]?.name;
        const mainText = document.querySelector("main")?.innerText || "";
        return (first && mainText.includes(first)) || attachmentPreviewCount() > previewsBefore;
      }, 8000);
      if (!appeared) throw new Error("ChatGPT 没有显示原生附件预览，本次未登记为上传成功");
      fillComposer(instruction(entry));
      let workflowResult = null;
      if (entry.autoRun) {
        reportWorkbenchProgress(task, "附件上传完成", 12, `${files.length} 个文件已进入 GPT`);
        workflowResult = await runAutomaticProduction(task);
      }
      task.status = "success";
      task.completed = task.total;
      const workflowDetail = workflowResult?.plannedOnly
        ? "迁移计划已生成，等待人工确认"
        : workflowResult?.packageSkipped
          ? `已下载 ${workflowResult.downloadedImages || 0} 张图并复制文案`
          : workflowResult?.textSkipped
            ? `已下载 ${workflowResult.downloadedImages || 0} 张图`
            : workflowResult?.packageResult?.packagePath
              ? `作品已核对并保存到 ${workflowResult.packageResult.packagePath}`
              : `${files.length} 个文件已上传`;
      reportWorkbenchTask(task, "success", workflowDetail);
      if (entry.entryKind === "material") {
        state.pendingUsage = entry;
        await recordMaterialUsage(entry, "prepared").catch(() => null);
      }
      renderQueue();
      setStatus(
        `已上传 ${files.length} 个文件，并保留原文案后追加生产指令`,
        "success"
      );
    } catch (error) {
      if (error?.name === "AbortError") {
        task.status = "cancelled";
        task.error = "";
        reportWorkbenchTask(task, "cancelled");
        setStatus(`已取消：${entry.name}`);
      } else {
        task.status = "failed";
        reportWorkbenchTask(task, "failed", error.message || "upload failed");
        task.error = error.message || "未知错误";
        setStatus(task.error, "danger");
      }
      renderQueue();
    } finally {
      state.busy = false;
      setBusy(null);
      processUploadQueue();
    }
  }

  function findEntry(kind, id) {
    if (kind === "product") {
      const groups = [
        state.productTree?.entries || [],
        ...Object.values(state.productChildren).map((tree) => tree.entries || [])
      ];
      for (const entries of groups) {
        const item = entries.find((entry) => entry.id === id);
        if (item) return item;
      }
      return null;
    }
    for (const category of state.materials?.categories || []) {
      const item = (category.items || []).find((entry) => entry.id === id);
      if (item) return item;
    }
    return (state.materialIndex?.items || []).find((entry) => entry.id === id) || null;
  }

  async function loadCategory(categoryId) {
    const category = (state.materials?.categories || []).find((item) => item.id === categoryId);
    if (!category || category.loaded || category.loading) return;
    category.loading = true;
    try {
      const payload = await api(`/api/materials?category=${encodeURIComponent(categoryId)}`);
      const loaded = (payload.materials?.categories || []).find((item) => item.id === categoryId);
      if (loaded) Object.assign(category, loaded, { loaded: true, loading: false });
      renderBody();
    } catch (error) {
      category.loading = false;
      setStatus(error.message, "danger");
    }
  }

  function recalculateLocalIndexStats() {
    const items = state.materialIndex?.items || [];
    const byMainTag = { 团建游戏: 0, 团建转化: 0, 合集攻略: 0 };
    const byUsage = { unused: 0, once: 0, twice: 0, threePlus: 0, used: 0 };
    items.forEach((item) => {
      if (Object.prototype.hasOwnProperty.call(byMainTag, item.mainTag)) byMainTag[item.mainTag] += 1;
      const count = Number(item.usageCount || 0);
      if (count === 0) byUsage.unused += 1;
      if (count === 1) byUsage.once += 1;
      if (count === 2) byUsage.twice += 1;
      if (count >= 3) byUsage.threePlus += 1;
      if (count > 0) byUsage.used += 1;
    });
    if (state.materialIndex) {
      state.materialIndex.stats = {
        ...(state.materialIndex.stats || {}),
        total: items.length,
        byMainTag,
        byUsage
      };
    }
  }

  function scheduleMaterialIndexPoll(delay = 3_000) {
    clearTimeout(materialIndexTimer);
    materialIndexTimer = setTimeout(() => {
      loadMaterialIndex().catch(() => null);
    }, delay);
  }

  async function loadMaterialIndex(refreshIndex = false) {
    const payload = await api(`/api/extension/material-index${refreshIndex ? "?refresh=true" : ""}`);
    state.materialIndex = payload.index || null;
    renderBody();
    if (state.materialIndex?.status === "running") {
      setStatus(`正在建立全库素材索引：${Number(state.materialIndex.processedCategories || 0)}/${Number(state.materialIndex.totalCategories || 0)}`);
      scheduleMaterialIndexPoll();
    } else if (state.materialIndex?.status === "failed") {
      setStatus(`素材索引失败：${state.materialIndex.error || "未知错误"}`, "danger");
    } else if (state.materialIndex?.status === "complete") {
      setStatus(`全库索引完成：${Number(state.materialIndex.stats?.total || 0)} 条素材，${Number(state.materialIndex.stats?.review || 0)} 条待核对`, "success");
    }
    return state.materialIndex;
  }

  async function materialEntryForUpload(id, categoryId) {
    let entry = findEntry("material", id);
    if (entry?.attachments?.length) return entry;
    if (categoryId) await loadCategory(categoryId);
    entry = findEntry("material", id);
    return entry;
  }

  function categoryForEntry(entryId) {
    return (state.materials?.categories || []).find((category) =>
      (category.items || []).some((item) => item.id === entryId)
    );
  }

  async function updateMaterialEntry(entry, changes) {
    if (!entry?.path) return;
    setStatus(`正在更新“${entry.name}”…`);
    const payload = await api("/api/extension/material-metadata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryPath: entry.path, folderHash: entry.folderHash, ...changes })
    });
    const record = payload.record || {};
    if (record.mainTag) {
      entry.mainTag = record.mainTag;
      entry.mainTagSource = record.mainTagSource || "manual";
    }
    if (Number.isFinite(Number(record.usageCount))) entry.usageCount = Number(record.usageCount);
    if (Array.isArray(record.tags)) entry.tags = record.tags;
    const indexed = (state.materialIndex?.items || []).find((item) => item.id === entry.id);
    if (indexed && indexed !== entry) Object.assign(indexed, {
      mainTag: entry.mainTag,
      mainTagSource: entry.mainTagSource,
      usageCount: entry.usageCount,
      tags: entry.tags
    });
    for (const category of state.materials?.categories || []) {
      const loaded = (category.items || []).find((item) => item.id === entry.id);
      if (loaded && loaded !== entry) Object.assign(loaded, {
        mainTag: entry.mainTag,
        mainTagSource: entry.mainTagSource,
        usageCount: entry.usageCount,
        tags: entry.tags
      });
    }
    recalculateLocalIndexStats();
    renderBody();
    setStatus(`已更新“${entry.name}”`, "success");
  }

  function saveMaterialActionSettings(form) {
    const next = JSON.parse(JSON.stringify(DEFAULT_ACTION_SETTINGS));
    for (const key of Object.keys(next)) {
      next[key].enabled = Boolean(form.querySelector(`[data-action-enabled="${key}"]`)?.checked);
      next[key].label = form.querySelector(`[data-action-label="${key}"]`)?.value || next[key].label;
    }
    next.move.targetPath = form.querySelector("[data-action-move-target]")?.value || "";
    storeActionSettings(next);
    state.settingsOpen = false;
    renderBody();
    setStatus("素材按钮设置已保存", "success");
  }

  async function loadProductFolder(folderPath) {
    setStatus(`正在读取 ${fileName(folderPath)}…`);
    const payload = await api(`/api/extension/product-tree?path=${encodeURIComponent(folderPath)}`);
    state.productChildren[folderPath] = payload.tree;
    renderBody();
    setStatus(`已读取 ${payload.tree?.entries?.length || 0} 项`, "success");
  }

  async function savePaths(kind, value) {
    const body = kind === "product"
      ? { workPackage: { libraryPath: value } }
      : { materialRoot: value };
    const payload = await api("/api/extension/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    state.workspace = { ...state.workspace, ...payload };
    storePaths({
      productRoot: kind === "product" ? value : state.paths.productRoot,
      materialRoot: kind === "material" ? value : state.paths.materialRoot
    });
    await refresh();
  }

  async function refresh() {
    try {
      const previousProductRoot = state.workspace?.settings?.workPackage?.libraryPath || state.paths.productRoot;
      const previousMaterialRoot = state.materials?.root || state.paths.materialRoot;
      const previousCategories = new Map(
        (state.materials?.categories || []).map((category) => [category.id, category])
      );
      const [workspace, materials, productTree, materialIndex] = await Promise.all([
        api("/api/extension/workspace"),
        api("/api/materials"),
        api("/api/extension/product-tree"),
        api("/api/extension/material-index")
      ]);
      state.workspace = workspace;
      state.productTree = productTree.tree;
      state.materialIndex = materialIndex.index || null;
      const nextProductRoot = workspace?.settings?.workPackage?.libraryPath || state.paths.productRoot;
      const nextMaterialRoot = materials.materials?.root || state.paths.materialRoot;
      const productRootChanged = previousProductRoot !== nextProductRoot;
      const materialRootChanged = previousMaterialRoot !== nextMaterialRoot;
      state.materials = {
        ...materials.materials,
        categories: (materials.materials?.categories || []).map((category) => {
          const previous = previousCategories.get(category.id);
          if (materialRootChanged || !previous?.loaded) return category;
          return { ...category, loaded: true, items: previous.items || [] };
        })
      };
      state.connected = true;
      state.health = {
        local: Boolean(nextProductRoot && nextMaterialRoot),
        gptUpload: Boolean(document.querySelector('#upload-files:not(:disabled)')),
        dedup: Boolean(workspace?.dedup?.production?.available)
      };
      storePaths({
        productRoot: nextProductRoot,
        materialRoot: nextMaterialRoot
      });
      if (productRootChanged) {
        state.productChildren = {};
        state.openProducts.clear();
      }
      if (materialRootChanged) state.openMaterials.clear();
      renderBody();
      renderHealth();
      setStatus("本地工作台已连接", "success");
      if (state.materialIndex?.status === "running") scheduleMaterialIndexPoll();
      scheduleRefresh(60_000);
    } catch {
      state.connected = false;
      state.health.local = false;
      state.health.dedup = false;
      state.health.gptUpload = Boolean(document.querySelector('#upload-files:not(:disabled)'));
      renderHealth();
      setStatus("正在自动连接本地工作台…", "danger");
      scheduleRefresh(5_000);
    }
  }

  function autoApplyPastedPath(input) {
    const productInput = input.matches(`#${ROOT_ID} [data-product-path]`);
    const materialInput = input.matches(`#${ROOT_ID} [data-material-path]`);
    if (!productInput && !materialInput) return;
    setTimeout(() => {
      const value = input.value.trim();
      if (!value) return;
      const kind = productInput ? "product" : "material";
      setStatus(`正在读取${kind === "product" ? "成品" : "素材"}目录…`);
      savePaths(kind, value).catch((error) => setStatus(error.message, "danger"));
    }, 80);
  }

  document.addEventListener("submit", (event) => {
    if (event.target.matches(`#${ROOT_ID} [data-product-form]`)) {
      event.preventDefault();
      savePaths("product", event.target.querySelector("[data-product-path]").value.trim()).catch((error) => setStatus(error.message, "danger"));
    }
    if (event.target.matches(`#${ROOT_ID} [data-material-form]`)) {
      event.preventDefault();
      savePaths("material", event.target.querySelector("[data-material-path]").value.trim()).catch((error) => setStatus(error.message, "danger"));
    }
    if (event.target.matches(`#${ROOT_ID} [data-material-settings-form]`)) {
      event.preventDefault();
      saveMaterialActionSettings(event.target);
    }
  });

  document.addEventListener("paste", (event) => {
    const input = event.target.closest?.(`#${ROOT_ID} input`);
    if (input) autoApplyPastedPath(input);
  });

  document.addEventListener("click", (event) => {
    if (event.target.closest(`#${ROOT_ID} [data-collapse], #${LAUNCHER_ID}`)) {
      state.collapsed = !state.collapsed;
      applyLayout();
      return;
    }
    const filterTag = event.target.closest(`#${ROOT_ID} [data-filter-main-tag]`);
    if (filterTag) {
      state.materialFilter.mainTag = filterTag.dataset.filterMainTag;
      renderBody();
      return;
    }
    const groupedFilter = event.target.closest(`#${ROOT_ID} [data-filter-dimension]`);
    if (groupedFilter) {
      const dimension = groupedFilter.dataset.filterDimension;
      if (dimension === "season" || dimension === "holiday") {
        state.materialFilter[dimension] = groupedFilter.dataset.filterValue;
        renderBody();
      }
      return;
    }
    if (event.target.closest(`#${ROOT_ID} [data-open-material-settings]`)) {
      state.settingsOpen = true;
      renderMaterialSettings();
      return;
    }
    if (event.target.closest(`#${ROOT_ID} [data-close-material-settings]`)) {
      state.settingsOpen = false;
      renderMaterialSettings();
      return;
    }
    if (event.target.closest(`#${ROOT_ID} [data-reset-material-settings]`)) {
      storeActionSettings(DEFAULT_ACTION_SETTINGS);
      renderMaterialSettings();
      return;
    }
    const tagAction = event.target.closest(`#${ROOT_ID} [data-material-main-tag]`);
    if (tagAction) {
      const entry = findEntry("material", tagAction.dataset.materialId);
      updateMaterialEntry(entry, { mainTag: tagAction.dataset.materialMainTag }).catch((error) => setStatus(error.message, "danger"));
      return;
    }
    const incrementAction = event.target.closest(`#${ROOT_ID} [data-material-increment]`);
    if (incrementAction) {
      const entry = findEntry("material", incrementAction.dataset.materialIncrement);
      updateMaterialEntry(entry, { incrementUsage: true }).catch((error) => setStatus(error.message, "danger"));
      return;
    }
    const moveAction = event.target.closest(`#${ROOT_ID} [data-material-move]`);
    if (moveAction) {
      const entry = findEntry("material", moveAction.dataset.materialMove);
      if (entry?.path && state.actionSettings.move.targetPath) {
        state.pendingMove = { entry: { ...entry, entryKind: "material" }, targetPath: state.actionSettings.move.targetPath };
        renderMoveDialog();
      }
      return;
    }
    const cancel = event.target.closest(`#${ROOT_ID} [data-cancel-upload]`);
    if (cancel) {
      const task = state.uploadTasks.find((item) => item.id === Number(cancel.dataset.cancelUpload));
      if (task) {
        if (task.status === "queued") {
          task.status = "cancelled";
          renderQueue();
        } else {
          task.controller.abort();
        }
      }
      return;
    }
    const retry = event.target.closest(`#${ROOT_ID} [data-retry-upload]`);
    if (retry) {
      const task = state.uploadTasks.find((item) => item.id === Number(retry.dataset.retryUpload));
      if (task) {
        task.status = "queued";
        task.completed = 0;
        task.error = "";
        task.controller = new AbortController();
        renderQueue();
        processUploadQueue();
      }
      return;
    }
    if (event.target.closest(`#${ROOT_ID} [data-cancel-move]`)) {
      state.pendingMove = null;
      renderMoveDialog();
      setStatus("已取消移动");
      return;
    }
    if (event.target.closest(`#${ROOT_ID} [data-confirm-move]`)) {
      confirmMove();
      return;
    }
    const productUpload = event.target.closest(`#${ROOT_ID} [data-upload-product]`);
    if (productUpload) uploadEntry({ ...findEntry("product", productUpload.dataset.uploadProduct), entryKind: "product" });
    const materialUpload = event.target.closest(`#${ROOT_ID} [data-upload-material]`);
    if (materialUpload) {
      materialEntryForUpload(
        materialUpload.dataset.uploadMaterial,
        materialUpload.dataset.indexCategory
      ).then((entry) => {
        if (!entry?.attachments?.length) throw new Error("素材详情尚未读取完成，请稍后再试");
        uploadEntry({ ...entry, entryKind: "material" });
      }).catch((error) => setStatus(error.message, "danger"));
    }
  });

  document.addEventListener("change", (event) => {
    const usage = event.target.closest?.(`#${ROOT_ID} [data-filter-usage]`);
    if (!usage) return;
    state.materialFilter.usage = usage.value;
    renderBody();
  });

  document.addEventListener("input", (event) => {
    const query = event.target.closest?.(`#${ROOT_ID} [data-filter-query]`);
    if (!query) return;
    state.materialFilter.query = query.value;
    const materials = document.querySelector(`#${ROOT_ID} [data-materials]`);
    if (materials) materials.innerHTML = materialRows();
  });

  document.addEventListener("toggle", (event) => {
    const product = event.target.closest?.(`#${ROOT_ID} details[data-product-path]`);
    if (product) {
      if (product.open) {
        const folderPath = product.dataset.productPath;
        state.openProducts.add(folderPath);
        if (!Object.prototype.hasOwnProperty.call(state.productChildren, folderPath)) {
          loadProductFolder(folderPath).catch((error) => setStatus(error.message, "danger"));
        }
      } else {
        state.openProducts.delete(product.dataset.productPath);
      }
      return;
    }
    const details = event.target.closest?.(`#${ROOT_ID} details[data-category]`);
    if (details) {
      if (details.open) {
        state.openMaterials.add(details.dataset.category);
        loadCategory(details.dataset.category);
      } else {
        state.openMaterials.delete(details.dataset.category);
      }
    }
  }, true);

  document.addEventListener("dragstart", (event) => {
    const row = event.target.closest?.(`#${ROOT_ID} [data-move-source-kind], #${ROOT_ID} [data-entry-kind]`);
    if (!row) return;
    const kind = row.dataset.moveSourceKind || row.dataset.entryKind;
    const id = row.dataset.moveSourceId || row.dataset.entryId;
    state.dragging = { ...findEntry(kind, id), entryKind: kind };
    if (!state.dragging?.path) {
      state.dragging = null;
      return;
    }
    showDropOverlay(false);
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData("text/plain", state.dragging?.name || "团建内容");
  });
  document.addEventListener("dragover", (event) => {
    if (!state.dragging) return;
    const moveTarget = event.target.closest?.(`#${ROOT_ID} [data-move-target-path]`);
    if (moveTarget && moveTarget.dataset.moveTargetPath !== state.dragging.path) {
      event.preventDefault();
      event.stopPropagation();
      clearMoveTarget();
      moveTarget.classList.add("is-move-target");
      state.moveTarget = moveTarget.dataset.moveTargetPath;
      event.dataTransfer.dropEffect = "move";
      showDropOverlay(false);
      return;
    }
    clearMoveTarget();
    if (isChatDropTarget(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      showDropOverlay(true);
    } else {
      showDropOverlay(false);
    }
  }, true);
  document.addEventListener("drop", (event) => {
    if (!state.dragging) return;
    const moveTarget = event.target.closest?.(`#${ROOT_ID} [data-move-target-path]`);
    if (moveTarget && moveTarget.dataset.moveTargetPath !== state.dragging.path) {
      event.preventDefault();
      event.stopPropagation();
      state.pendingMove = {
        entry: state.dragging,
        targetPath: moveTarget.dataset.moveTargetPath
      };
      state.dragging = null;
      clearMoveTarget();
      showDropOverlay(false);
      renderMoveDialog();
      return;
    }
    if (!isChatDropTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    const entry = state.dragging;
    state.dragging = null;
    clearMoveTarget();
    showDropOverlay(false);
    uploadEntry(entry);
  }, true);
  document.addEventListener("dragend", () => {
    state.dragging = null;
    clearMoveTarget();
    showDropOverlay(false);
  });

  document.addEventListener("click", (event) => {
    if (!state.pendingUsage || event.target.closest?.(`#${ROOT_ID}`)) return;
    const button = event.target.closest?.("button");
    if (!button) return;
    const label = `${button.getAttribute("aria-label") || ""} ${button.title || ""} ${button.textContent || ""}`;
    if (/发送|send/i.test(label)) commitPendingMaterialUsage();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (!state.pendingUsage || event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    if (event.target.closest?.(`#${ROOT_ID}`)) return;
    if (event.target.matches?.("textarea, [contenteditable='true']")) commitPendingMaterialUsage();
  }, true);

  function acceptWorkbenchTask(message) {
    if (message?.source !== "teambuilding-workbench"
      || message?.type !== "tb-workbench-upload") return;
    const requestId = String(message.requestId || "").trim();
    document.documentElement.dataset.tbGptLastTask = `${requestId || "missing"}:received`;
    const attachments = Array.isArray(message.attachments)
      ? [...new Set(message.attachments.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 30)
      : [];
    const prompt = String(message.prompt || "").trim().slice(0, 30000);
    if (!requestId || !attachments.length || !prompt) {
      window.postMessage({
        source: "tb-gpt-production-extension",
        type: "tb-workbench-task-result",
        requestId,
        status: "failed",
        detail: "missing requestId, attachments or prompt"
      }, "*");
      return;
    }
    uploadEntry({
      id: `workbench-${requestId}`,
      name: String(message.name || "工作台素材").slice(0, 160),
      path: String(message.materialPath || message.name || "工作台素材"),
      attachments,
      imageCount: attachments.filter((filePath) => /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(filePath)).length,
      entryKind: "external",
      customPrompt: prompt,
      externalRequestId: requestId,
      autoRun: Boolean(message.autoRun),
      autoOptions: message.autoOptions && typeof message.autoOptions === "object" ? message.autoOptions : {}
    });
  }

  window.addEventListener("message", (event) => {
    acceptWorkbenchTask(event.data);
  });

  document.addEventListener("tb-workbench-upload", () => {
    try {
      const bridge = document.getElementById("tb-workbench-bridge-request");
      acceptWorkbenchTask(JSON.parse(bridge?.textContent || "{}"));
    } catch (error) {
      document.documentElement.dataset.tbGptLastTask = `bridge:failed:${error.message}`;
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "tb-sidebar-toggle") return;
    state.collapsed = !state.collapsed;
    applyLayout();
  });

  if (!isEmbeddedWorkbench()) render();
  Promise.all([readStoredPaths(), readActionSettings()]).then(([paths, actionSettings]) => {
    state.actionSettings = actionSettings;
    storePaths(paths);
    if (!isEmbeddedWorkbench()) {
      renderBody();
      return refresh();
    }
    return null;
  });

  const mountObserver = new MutationObserver(() => {
    if (isEmbeddedWorkbench()) return;
    if (document.getElementById(ROOT_ID) && document.getElementById(LAUNCHER_ID)) return;
    if (remountQueued) return;
    remountQueued = true;
    requestAnimationFrame(() => {
      remountQueued = false;
      render();
    });
  });
  mountObserver.observe(document.documentElement, { childList: true, subtree: true });
})();
