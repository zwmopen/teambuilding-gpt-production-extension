# AI 接手规则

1. 先读 `README.md`、`docs/DESIGN.md`、`docs/ARCHITECTURE.md` 和 `docs/HANDOFF.md`。
2. `src/` 是浏览器扩展唯一源码真源；不要在工作台项目里维护第二份扩展源码。
3. `docs/HANDOFF.md` 是唯一权威开发交接文档。
4. 功能变化同步更新 `VERSION`、`README.md`、`CHANGELOG.md` 和受影响文档。
5. 不提交用户素材、作品、历史数据库、Cookie、Token 或浏览器登录数据。
6. 发布前运行自动测试，并在真实 ChatGPT 页面完成一次人工可见验收。
