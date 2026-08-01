(function initTeambuildingGptAutomationCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TeambuildingGptAutomationCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function parsePlannedImageCount(text) {
    const source = String(text || "");
    const explicit = [...source.matchAll(/(?:预计输出(?:总)?(?:张数|页数)|输出总张数|共计|合计)\s*[：:]?\s*(\d{1,2})\s*(?:张|页)/gi)]
      .map((match) => Number(match[1]))
      .filter((value) => value > 0 && value <= 30);
    if (explicit.length) return explicit[explicit.length - 1];
    const pages = [...source.matchAll(/(?:^|[\n\r\s｜|])P\s*(\d{1,2})(?=\s*(?:[｜|：:\-—]|$))/gim)]
      .map((match) => Number(match[1]))
      .filter((value) => value > 0 && value <= 30);
    return pages.length ? Math.max(...pages) : 0;
  }

  function uniqueGeneratedImageUrls(urls) {
    const seen = new Set();
    return (Array.isArray(urls) ? urls : []).map((value) => String(value || "").trim()).filter((url) => {
      if (!/^(?:https?:|blob:|data:image\/)/i.test(url) || seen.has(url)) return false;
      seen.add(url);
      return true;
    });
  }

  function isCompleteCopy(text, minimum = 300) {
    return String(text || "").replace(/\s/g, "").length >= Math.max(1, Number(minimum || 300));
  }

  function isLikelyPublishCopy(text, minimum = 300) {
    const source = String(text || "").trim();
    if (!isCompleteCopy(source, minimum)) return false;
    if (/母版页数不是输出上限|逐页迁移计划|迁移计划|等待.{0,12}(?:回复|输入).{0,6}1|暂时不出图/i.test(source)) return false;
    const pageHeadings = source.match(/(?:^|\n)\s*P\s*\d{1,2}\s*[｜|：:\-—]/gim) || [];
    if (pageHeadings.length >= 2) return false;
    return /#[^\s#]{2,}|(?:适合|地点|行程|玩法|团建|公司团队|出发前)/i.test(source);
  }

  return { parsePlannedImageCount, uniqueGeneratedImageUrls, isCompleteCopy, isLikelyPublishCopy };
});
