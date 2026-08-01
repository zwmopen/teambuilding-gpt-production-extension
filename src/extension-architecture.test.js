const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = __dirname;

test("自动生产核心能够解析计划页数并去重 A/B 图片", () => {
  const corePath = path.join(root, "gpt-automation-core.js");
  assert.ok(fs.existsSync(corePath), "缺少独立可测试的 GPT 自动生产核心");
  const core = require(corePath);
  const plan = [
    "【母版页数不是输出上限。】",
    "P1｜广州两天一夜封面",
    "P2｜酒店入住",
    "P3｜团建活动",
    "P4｜晚宴",
    "预计输出总张数：4张"
  ].join("\n");
  assert.equal(core.parsePlannedImageCount(plan), 4);
  assert.deepEqual(core.uniqueGeneratedImageUrls([
    "https://example.com/a.png",
    "https://example.com/a.png",
    "blob:https://chatgpt.com/b"
  ]), ["https://example.com/a.png", "blob:https://chatgpt.com/b"]);
  assert.equal(core.buildMissingPagesPrompt, undefined);
  assert.equal(core.isCompleteCopy("中".repeat(299), 300), false);
  assert.equal(core.isCompleteCopy("中".repeat(300), 300), true);
  assert.equal(core.isLikelyPublishCopy(`【母版页数不是输出上限。】\n逐页迁移计划\nP1｜封面\nP2｜内页\n${"中".repeat(320)}`, 300), false);
  assert.equal(core.isLikelyPublishCopy(`杭州一日团建｜春日农庄参考\n${"适合公司团队轻松出游。".repeat(35)}\n#杭州团建 #江浙沪团建`, 300), true);
});

test("扩展把最新版网页助手与右侧生产舱拆成两个独立模块", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js || []);
  assert.ok(scripts.includes("vendor/chatgpt-conversation-tree.user.js"));
  assert.ok(scripts.includes("sidebar.js"));
  assert.ok(scripts.indexOf("sidebar.js") < scripts.indexOf("vendor/chatgpt-conversation-tree.user.js"));
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1/*"));
  assert.ok(manifest.host_permissions.includes("https://raw.githubusercontent.com/*"));
  assert.ok(manifest.permissions.includes("downloads"));
  assert.equal(manifest.name, "团建 GPT 数字作品生产助手");
  assert.equal(manifest.version, "0.2.15");
});

test("GPT web controls stay visible and place prompt panel inside viewport", () => {
  const vendor = fs.readFileSync(path.join(root, "vendor", "chatgpt-conversation-tree.user.js"), "utf8");
  assert.match(vendor, /availableBelow/);
  assert.match(vendor, /min-width: 58px/);
  assert.match(vendor, /cgpt-image-download-label/);
  assert.match(vendor, /width: min\(320px/);
  assert.match(vendor, /addDiagnosticLog\('script:init'\);[\s\S]*injectStyles\(\);/);
  assert.match(vendor, /imageGroupsOnPage\(\)\.forEach/);
  assert.match(vendor, /function isAssistantGeneratedImage\(img\)/);
  assert.match(vendor, /closest\?\.\('\[data-message-author-role="user"\], article\[data-turn="user"\]'\)/);
  assert.match(vendor, /\[id\^="image-"\]\[class\*="imagegen-image"\]/);
  assert.match(vendor, /contentImageElements\(document\)[\s\S]{0,80}\.filter\(isAssistantGeneratedImage\)/);
  assert.match(vendor, /function isNearViewport\(element/);
  assert.match(vendor, /function generatingNow\(\)/);
  assert.match(vendor, /button\[data-testid="stop-button"\]/);
  assert.match(vendor, /if \(generatingNow\(\)\) \{[\s\S]*2400/);
  assert.match(vendor, /document\.addEventListener\('scroll', \(\) => scheduleImageDownloadButtons\(\)/);
  assert.match(vendor, /image-gen-overlay-right-actions/);
  assert.match(vendor, /display:\s*none !important/);
  assert.match(vendor, /exactly one slot per generated assistant turn/i);
});

test("embedded automation can toggle prompt and download tools and rejects incomplete image sets", () => {
  const source = fs.readFileSync(path.join(root, "sidebar.js"), "utf8");
  const vendor = fs.readFileSync(path.join(root, "vendor", "chatgpt-conversation-tree.user.js"), "utf8");
  assert.match(source, /tb-workbench-prompt-library-enabled/);
  assert.match(source, /tb-workbench-message-downloads-enabled/);
  assert.match(source, /minimumImageCount/);
  assert.match(source, /生成(?:结果|图片)不足/);
  assert.match(source, /downloadRoot/);
  assert.match(source, /productRoot/);
  assert.match(vendor, /promptLibraryEnabled/);
  assert.match(vendor, /messageDownloadToolsEnabled/);
});

test("内置工作台模式复用原生 GPT 并接收左侧素材与模板任务", () => {
  const source = fs.readFileSync(path.join(root, "sidebar.js"), "utf8");
  const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
  assert.match(source, /tb-workbench-embedded/);
  assert.match(source, /TeambuildingWorkbenchGPT/);
  assert.match(source, /tb-workbench-upload/);
  assert.match(source, /tb-workbench-task-result/);
  assert.match(source, /customPrompt/);
  assert.match(source, /if \(!isEmbeddedWorkbench\(\)\) render\(\)/);
  assert.match(source, /\[role="group"\]\[aria-label\]/);
  assert.match(source, /attachmentPreviewCount\(\) >= previewsBefore \+ files\.length/);
  assert.match(source, /document\.querySelector\('#composer-submit-button:not\(:disabled\), \[data-testid="send-button"\]:not\(:disabled\)'\)/);
  assert.match(source, /document\.querySelectorAll\('\[data-message-author-role="user"\]'\)\.length > beforeUserCount/);
  assert.match(source, /minTextLength:\s*4/);
  assert.doesNotMatch(source, /planCorrectionSubmitted/);
  assert.match(source, /本素材已跳过，未自动重写或发送 1/);
  assert.match(source, /baseUrl:\s*currentApiRoot\(\)/);
  assert.match(source, /恢复下载图片/);
  assert.match(source, /task\.workflow\?\.planSubmitted \|\| entry\.retryFromStage/);
  assert.match(source, /resumeOnly/);
  assert.match(source, /\/api\/extension\/save-generated-image/);
  assert.match(source, /等待 30 秒后仍没有找到最近一次生成图片/);
  assert.doesNotMatch(source, /textCorrectionSubmitted/);
  assert.match(source, /latestPairedCopyTurn/);
  assert.doesNotMatch(source, /首次文案请求没有产生正文/);
  assert.doesNotMatch(source, /textRetrySubmitted/);
  assert.match(source, /generatedImageNodes/);
  assert.match(source, /img\[alt="输出图片"\]/);
  assert.match(source, /button\.disabled \|\| rect\.width <= 0 \|\| rect\.height <= 0/);
  assert.match(source, /const roleTurns = \[\.\.\.document\.querySelectorAll\('\[data-message-author-role="assistant"\]'\)\]/);
  assert.match(source, /turn\.closest\('\[data-message-author-role\]'\) === turn/);
  assert.match(source, /function assistantTurnKey\(turn, index = 0\)/);
  assert.match(source, /baselineKeys: initialAssistantKeys/);
  assert.match(source, /Date\.now\(\) - stableSince >= 1_800/);
  assert.match(source, /1_000 \+ Math\.floor\(Math\.random\(\) \* 4_001\)/);
  assert.match(source, /恢复迁移计划/);
  assert.match(source, /恢复小红书文案/);
  assert.match(source, /图片后台下载/);
  assert.match(source, /剪贴板不可用，继续直接写入 TXT/);
  assert.match(source, /"等待迁移计划"/);
  assert.match(source, /stop response\|\\u505c\\u6b62\\u751f\\u6210\|\\u505c\\u6b62\\u56de\\u7b54/);
  assert.match(source, /dismissImageComparison\(\);[\s\S]*generatedImageUrls/);
  assert.match(source, /stoppedWithoutGrowthSince/);
  assert.match(source, /parsePlannedImageCount/);
  assert.doesNotMatch(source, /buildMissingPagesPrompt/);
  assert.match(source, /不补页、不续作、不打包/);
  assert.match(source, /latestCopyTurnAfterPrompt/);
  assert.match(source, /strict publish-copy predicate/);
  assert.match(source, /checkpointDirectories\.length === 1/);
  assert.match(source, /gpt-production\/checkpoint/);
  assert.match(source, /recover-image-batch/);
  assert.match(source, /不少于 300 个可见字符/);
  assert.match(background, /allowedLocalRoot/);
  assert.match(background, /127\\\.0\\\.0\\\.1/);
  assert.match(source, /packageResult\.duplicate/);
  assert.match(source, /duplicateSkipped:\s*true/);
  assert.match(source, /已删除本轮/);
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
  assert.match(source, /authoritative duplicate decision is the[\s\S]*output image-set hash/);
  assert.doesNotMatch(source, /已拦截重复内容/);
  assert.match(source, /\/api\/extension\/material-use/);
  assert.match(source, /\/api\/extension\/material-usage-check/);
  assert.match(source, /if \(usage\?\.record\) entry\.usage = usage\.record/);
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
  assert.match(triggerSource, /response\.duplicate/);
  assert.match(triggerSource, /setWorkPackageButtonState\(button, 'duplicate'\)/);
  assert.match(vendor, /重复已跳过/);
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

test("manual production can invoke visible download, package and text actions", () => {
  const vendor = fs.readFileSync(path.join(root, "vendor", "chatgpt-conversation-tree.user.js"), "utf8");
  assert.match(vendor, /async manualAction\(action = 'download'\)/);
  assert.match(vendor, /action === 'package'/);
  assert.match(vendor, /action === 'copy-text'/);
  assert.match(vendor, /action === 'download-text'/);
  assert.match(vendor, /refreshImageDownloadButtons\(\)/);
});

test("automatic copy waits for streaming to finish before packaging", () => {
  const source = fs.readFileSync(path.join(root, "sidebar.js"), "utf8");
  const start = source.indexOf("async function waitForPublishCopy");
  const end = source.indexOf("function generatedImageNodes", start);
  const waitSource = source.slice(start, end);
  assert.ok(start > -1 && end > start);
  assert.match(waitSource, /!generatingNow\(\)/);
  assert.match(waitSource, /stableSince/);
  assert.match(waitSource, />= 2_500/);
  assert.doesNotMatch(waitSource, /isLikelyPublishCopy\(text, 300\)\) return/);
});

test("resume after a pre-bridge pause forces the material upload instead of skipping attachments", () => {
  const source = fs.readFileSync(path.join(root, "sidebar.js"), "utf8");
  assert.match(source, /const forceUpload = Boolean\(message\.forceUpload\)/);
  assert.match(source, /const resumeOnly = Boolean\(retryFromStage\) && !forceUpload/);
  assert.match(source, /const resumeExistingWorkflow = !entry\.forceUpload/);
  assert.match(source, /retryTask\.entry\.forceUpload = forceUpload/);
});
