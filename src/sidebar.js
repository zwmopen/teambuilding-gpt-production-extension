(() => {
  const API_ROOT = "http://127.0.0.1:4327";
  const ROOT_ID = "tb-gpt-production-studio";
  const LAUNCHER_ID = "tb-gpt-production-launcher";
  const DROP_OVERLAY_ID = "tb-gpt-production-drop-overlay";
  const PATH_STORAGE_KEY = "tb-production-paths";
  const DEFAULT_PATHS = Object.freeze({
    productRoot: "D:\\AICode\\项目推进\\projects\\江湖有旅人\\主项目\\成品库（GPT+本地脚本制作）",
    materialRoot: "D:\\AICode\\项目推进\\projects\\江湖有旅人\\主项目\\01-素材库"
  });
  const state = {
    workspace: null,
    materials: null,
    paths: { ...DEFAULT_PATHS },
    productTree: null,
    productChildren: {},
    openProducts: new Set(),
    openMaterials: new Set(),
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
  localStorage.removeItem("tb-studio-collapsed");

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
  const fileName = (filePath) => String(filePath || "").split(/[\\/]/).pop() || "本地文件";

  async function api(pathname, options = {}) {
    const result = await chrome.runtime.sendMessage({
      type: "tb-local-request",
      path: pathname,
      method: options.method || "GET",
      body: options.body ? JSON.parse(options.body) : undefined
    });
    if (!result?.ok) throw new Error(result?.error || "本地工作台连接失败");
    return result.data;
  }

  async function readLocalFile(filePath, responseType = "base64", signal = null) {
    if (signal?.aborted) throw new DOMException("上传已取消", "AbortError");
    const request = chrome.runtime.sendMessage({
      type: "tb-local-request",
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

  function materialRows() {
    const categories = state.materials?.categories || [];
    return categories.map((category) => `
      <details class="tb-tree-group" data-category="${escapeHtml(category.id)}"
        ${state.openMaterials.has(category.id) ? "open" : ""}>
        <summary data-move-target-path="${escapeHtml(category.path)}"><span class="tb-folder-icon"></span><b title="${escapeHtml(category.name)}">${escapeHtml(category.name)}</b><small>${Number(category.count || 0)}</small></summary>
        <div class="tb-tree-items">
          ${category.loaded ? (category.items || []).map((item) => `
            <article class="tb-work-row ${item.usage?.status === "used" ? "is-used" : ""}" draggable="${item.usage?.status === "used" ? "false" : "true"}"
              data-entry-kind="material" data-entry-id="${escapeHtml(item.id)}"
              data-move-source-kind="material" data-move-source-id="${escapeHtml(item.id)}">
              <span class="tb-post-folder" aria-hidden="true"><i class="tb-folder-icon"></i></span>
              <span class="tb-work-copy">
                <span class="tb-work-name" title="${escapeHtml(item.path || item.name)}">${escapeHtml(item.name)}</span>
                <small>${Number(item.imageCount || 0)} 张图 · ${Number(item.textCount || 0)} 个文档${item.usage?.status === "used" ? " · 已使用" : item.usage?.status === "prepared" ? " · 已加入 GPT" : ""}</small>
              </span>
              <button type="button" data-upload-material="${escapeHtml(item.id)}" ${item.usage?.status === "used" ? "disabled" : ""}>
                ${item.usage?.status === "used" ? "已使用" : "传 GPT"}
              </button>
            </article>
          `).join("") : `<div class="tb-empty compact">展开后读取这个文件夹</div>`}
        </div>
      </details>
    `).join("") || `<div class="tb-empty">素材目录中还没有识别到“图片 + 文案”帖子</div>`;
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
    root.querySelector("[data-materials]").innerHTML = materialRows();
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
    return document.querySelector('#upload-files:not(:disabled)')
      || document.querySelector('input[data-testid="upload-files-input"]:not(:disabled)');
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
      task.status = "success";
      task.completed = task.total;
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
        setStatus(`已取消：${entry.name}`);
      } else {
        task.status = "failed";
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
    return null;
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
      const [workspace, materials, productTree] = await Promise.all([
        api("/api/extension/workspace"),
        api("/api/materials"),
        api("/api/extension/product-tree")
      ]);
      state.workspace = workspace;
      state.productTree = productTree.tree;
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
    if (materialUpload) uploadEntry({ ...findEntry("material", materialUpload.dataset.uploadMaterial), entryKind: "material" });
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

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "tb-sidebar-toggle") return;
    state.collapsed = !state.collapsed;
    applyLayout();
  });

  render();
  readStoredPaths().then((paths) => {
    storePaths(paths);
    renderBody();
    return refresh();
  });

  const mountObserver = new MutationObserver(() => {
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
