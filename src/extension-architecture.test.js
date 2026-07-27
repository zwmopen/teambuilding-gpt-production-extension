const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = __dirname;

test("扩展把最新版网页助手与右侧生产舱拆成两个独立模块", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js || []);
  assert.ok(scripts.includes("vendor/chatgpt-conversation-tree.user.js"));
  assert.ok(scripts.includes("sidebar.js"));
  assert.ok(scripts.indexOf("vendor/chatgpt-conversation-tree.user.js") < scripts.indexOf("sidebar.js"));
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1:4327/*"));
  assert.ok(manifest.host_permissions.includes("https://raw.githubusercontent.com/*"));
  assert.ok(manifest.permissions.includes("downloads"));
  assert.equal(manifest.name, "团建 GPT 数字作品生产助手");
  assert.equal(manifest.version, "0.2.2");
});

test("右侧生产舱同时声明成品、素材、路径设置和附件上传入口", () => {
  const source = fs.readFileSync(path.join(root, "sidebar.js"), "utf8");
  const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
  const shim = fs.readFileSync(path.join(root, "gm-shim.js"), "utf8");
  assert.match(source, /\/api\/extension\/workspace/);
  assert.match(source, /\/api\/extension\/settings/);
  assert.match(source, /\/api\/extension\/product-tree/);
  assert.match(source, /\/api\/materials/);
  assert.match(source, /loadCategory/);
  assert.match(source, /openMaterials/);
  assert.match(source, /state\.openMaterials\.add/);
  assert.match(source, /previousCategories/);
  assert.match(source, /productRootChanged/);
  assert.match(source, /materialRootChanged/);
  assert.match(source, /#upload-files/);
  assert.match(source, /input\.files\.length !== files\.length/);
  assert.match(source, /uploadTasks/);
  assert.match(source, /processUploadQueue/);
  assert.match(source, /data-cancel-upload/);
  assert.match(source, /data-retry-upload/);
  assert.match(source, /DROP_OVERLAY_ID/);
  assert.match(source, /checkEntryDuplicate/);
  assert.match(source, /\/api\/dedup\/check-text/);
  assert.match(source, /\/api\/extension\/material-use/);
  assert.match(source, /\/api\/extension\/material-usage-check/);
  assert.match(source, /内容指纹与已使用素材一致/);
  assert.match(source, /commitPendingMaterialUsage/);
  assert.match(source, /已登记使用/);
  assert.match(source, /data-health/);
  assert.match(source, /tb-local-request/);
  assert.match(background, /tb-local-request/);
  assert.match(background, /tb-download-status/);
  assert.match(background, /\/api\/extension\/download-event/);
  assert.match(shim, /downloadCallbacks/);
  assert.match(shim, /tb-download-status/);
  assert.match(source, /#upload-files/);
  assert.doesNotMatch(source, /querySelectorAll\(['"]input\[type="file"\]/);
  assert.match(source, /DataTransfer/);
  assert.match(source, /成品区/);
  assert.match(source, /素材区/);
  assert.match(source, /图片 \+ 文案/);
  assert.match(source, /details class="tb-tree-group tb-product-group"/);
  assert.match(source, /details\[data-product-path\]/);
  assert.match(source, /tb-production-paths/);
  assert.match(source, /D:\\\\AICode\\\\项目推进\\\\projects\\\\江湖有旅人\\\\主项目\\\\01-素材库/);
  assert.match(source, /D:\\\\AICode\\\\项目推进\\\\projects\\\\江湖有旅人\\\\主项目\\\\成品库（GPT\+本地脚本制作）/);
  assert.match(source, /chrome\.storage\.local\.get/);
  assert.match(source, /chrome\.storage\.local\.set/);
  assert.match(source, /document\.addEventListener\("paste"/);
  assert.match(source, /正在自动连接本地工作台/);
  assert.match(source, /scheduleRefresh\(5_000\)/);
});

test("扩展不接管 ChatGPT 原生左侧会话，也不覆盖输入框已有文案", () => {
  const source = fs.readFileSync(path.join(root, "sidebar.js"), "utf8");
  const vendor = fs.readFileSync(path.join(root, "vendor", "chatgpt-conversation-tree.user.js"), "utf8");
  assert.match(vendor, /const ENABLE_CONVERSATION_TREE = false/);
  assert.match(vendor, /if \(!ENABLE_CONVERSATION_TREE\) return/);
  assert.match(source, /function mergeComposerText/);
  assert.match(source, /existingText/);
  assert.doesNotMatch(source, /target\.innerHTML = ""/);
  assert.match(source, /isChatDropTarget/);
  assert.match(source, /closest\?\.\("main"\)/);
  assert.doesNotMatch(source, /state\.dragging && !event\.target\.closest\?\.\(`#\$\{ROOT_ID\}`\)/);
});

test("提示词入口与面板事件不依赖已停用的左侧会话树", () => {
  const vendor = fs.readFileSync(path.join(root, "vendor", "chatgpt-conversation-tree.user.js"), "utf8");
  const panelStart = vendor.indexOf("function ensurePromptPanel");
  const panelEnd = vendor.indexOf("function promptComposerInput", panelStart);
  const buttonStart = vendor.indexOf("function ensurePromptButton");
  const buttonEnd = vendor.indexOf("function schedulePromptButton", buttonStart);
  assert.ok(panelStart > -1 && panelEnd > panelStart);
  assert.ok(buttonStart > -1 && buttonEnd > buttonStart);
  assert.match(vendor.slice(panelStart, panelEnd), /panel\.addEventListener\('click'/);
  assert.match(vendor.slice(buttonStart, buttonEnd), /button\.addEventListener\('click'/);
  assert.match(vendor, /ensurePromptButton\(\);/);
});

test("右侧文件树支持经确认的真实文件夹移动", () => {
  const source = fs.readFileSync(path.join(root, "sidebar.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "sidebar.css"), "utf8");
  assert.match(source, /\/api\/extension\/move-entry/);
  assert.match(source, /pendingMove/);
  assert.match(source, /data-confirm-move/);
  assert.match(source, /data-cancel-move/);
  assert.match(source, /dropEffect = "move"/);
  assert.match(css, /\.is-move-target/);
  assert.match(css, /\.tb-move-confirm/);
});

test("素材文件夹支持母标签、季节节日分组、哈希、次数筛选和自定义按钮", () => {
  const source = fs.readFileSync(path.join(root, "sidebar.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "sidebar.css"), "utf8");
  assert.match(source, /\["全部", "团建游戏", "团建转化", "合集攻略"\]/);
  assert.match(source, /item\.mainTag !== mainTag/);
  assert.match(source, /SEASON_TAGS/);
  assert.match(source, /HOLIDAY_TAGS/);
  assert.match(source, /data-filter-dimension/);
  assert.match(source, /materialHasGroupedTag/);
  assert.match(source, /item\.folderHash/);
  assert.match(source, /item\.usageCount/);
  assert.match(source, /data-filter-usage/);
  assert.match(source, /data-filter-query/);
  assert.match(source, /\/api\/extension\/material-metadata/);
  assert.match(source, /\/api\/extension\/material-index/);
  assert.match(source, /incrementUsage: true/);
  assert.match(source, /globalMaterialRows/);
  assert.match(source, /usageSource/);
  assert.match(source, /待核对/);
  assert.match(source, /stats\?\.byMainTag/);
  assert.match(source, /stats\?\.byUsage/);
  assert.match(source, /ACTION_STORAGE_KEY/);
  assert.match(source, /每个文件夹只保留一个母标签/);
  assert.match(css, /\.tb-material-filter/);
  assert.match(css, /\.tb-filter-dimensions/);
  assert.match(css, /\.tb-filter-group/);
  assert.match(css, /\.tb-material-meta/);
  assert.match(css, /\.tb-material-settings/);
});

test("扩展内的打包按钮直连工作台，不再默认唤起 VBS 协议", () => {
  const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
  const vendor = fs.readFileSync(path.join(root, "vendor", "chatgpt-conversation-tree.user.js"), "utf8");
  assert.match(background, /tb-work-package/);
  assert.match(background, /\/api\/extension\/work-package/);
  const triggerStart = vendor.indexOf("async function triggerWorkPackageButton");
  const triggerEnd = vendor.indexOf("function openWorkPackageProtocol", triggerStart);
  const triggerSource = vendor.slice(triggerStart, triggerEnd);
  assert.match(triggerSource, /chrome\.runtime\.sendMessage/);
  assert.match(triggerSource, /tb-work-package/);
  assert.doesNotMatch(triggerSource, /openWorkPackageProtocol/);
});

test("右侧生产舱采用上下分区并为 ChatGPT 中间区预留宽度", () => {
  const source = fs.readFileSync(path.join(root, "sidebar.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "sidebar.css"), "utf8");
  assert.match(css, /--tb-studio-width/);
  assert.match(css, /grid-template-rows:[^;]*minmax\(0,\s*1fr\)[^;]*minmax\(0,\s*1fr\)/s);
  assert.match(css, /margin-right:\s*var\(--tb-studio-offset\)/);
  assert.match(source, /collapsed:\s*false/);
  assert.match(source, /LAUNCHER_ID/);
  assert.match(source, /launcher\.hidden\s*=\s*!state\.collapsed/);
  assert.doesNotMatch(source, /localStorage\.setItem\("tb-studio-collapsed"/);
  assert.match(source, /document\.body\s*\|\|\s*document\.documentElement/);
  assert.match(source, /new MutationObserver/);
  assert.match(source, /mountObserver\.observe\(document\.documentElement/);
  assert.match(css, /\.tb-studio-reopen\[hidden\]/);
});
