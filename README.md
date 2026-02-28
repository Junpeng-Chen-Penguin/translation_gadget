# 标准词库工具（本地代理模式）

## 启动前检查
1. Node.js 版本建议 `18+`（本项目是纯 Node 内置模块，无需 `npm install`）。
2. 二选一配置 AI 鉴权：
   - 本地开发：`ai-config.local.js`
   - 线上部署（推荐）：环境变量 `AI_API_KEY` / `AI_BASE_URL` / `AI_ENDPOINT` / `AI_MODEL`
3. `ai-config.local.js` 示例：
```js
// Local AI config (do not commit)
window.AI_CONFIG = {
  apiKey: "your_key",
  baseUrl: "https://your-proxy-domain/us",
  endpoint: "/azure/responses",
  model: "gpt-5.1-mini"
};
```

## 启动方式
1. 进入目录
```bash
cd /Users/chenjunpeng/Documents/MytePro/International/standard-lexicon-html
```

2. 启动服务（默认端口 `8787`）
```bash
node server.js
```

3. 如果默认端口不可用，换端口启动
```bash
PORT=8788 node server.js
```

4. 健康检查
```bash
curl http://127.0.0.1:8787/api/health
```
返回 `{"ok":true}` 表示服务与上游代理连通。

5. 浏览器访问
```text
http://127.0.0.1:8787
```

## 接口说明
- `POST /api/translate`
- `GET /api/health`
- `GET /api/lexicon`：读取工程词库文件 `data/standard-lexicon.csv`
- `POST /api/lexicon`：更新工程词库文件（请求体：`{ rows: [{ source_text, translation_en, lexicon_type }] }`）

本地服务会把请求转发到 `ai-config.local.js` 中配置的代理地址；前端不再直接调用外部代理。

## 配置优先级
1. 若存在环境变量 `AI_API_KEY`，服务端优先使用环境变量。
2. 否则回退读取 `ai-config.local.js`。
3. `AI_BASE_URL` 默认 `https://api.openai.com/v1`，`AI_ENDPOINT` 默认 `/azure/responses`，`AI_MODEL` 默认 `gpt-5.1-mini`。

## 标准词库存储
- 标准词库文件路径：`data/standard-lexicon.csv`
- 服务启动时不自动加载词库；在“标准词库”页点击“引入词库”才会读取该文件。
- 在页面里修改后点击“更新词库”，会把当前词库写回 `data/standard-lexicon.csv`。

## Prompt 管理（统一入口）
- AI 翻译 Prompt 统一维护在：
  - `prompts/ai-translate.prompt.md`
- 模板变量：
  - `{{LEXICON_SECTION}}`：服务端注入标准词库与术语一致性规则
  - `{{INPUT_ROWS_JSON}}`：服务端注入当前待翻译词条 JSON
- 调优时优先修改该模板文件，无需改 `server.js` 业务逻辑。

## 常见启动失败
1. `EADDRINUSE`：端口被占用，使用 `PORT=8788 node server.js`。
2. `EPERM`：当前环境禁止监听端口，换本机终端运行或调整系统/容器权限。
3. `缺少 ai-config.local.js` 或 `未配置 apiKey`：检查配置文件内容。
4. `invalid_config`：`endpoint` 必须是 `responses` 路径（例如 `"/azure/responses"`）。

## 模型与接口匹配
- 当前本地代理仅支持 `responses` 模式。
- `endpoint` 请固定为 `"/azure/responses"`（或你们网关对应的 responses 路径）。

## 发布到 GitHub
1. 在工具目录执行：
```bash
cd /Users/chenjunpeng/Documents/MytePro/International/standard-lexicon-html
git init
git add .
git commit -m "chore: prepare github + vercel deployment"
```
2. 在 GitHub 创建一个空仓库（不要勾选 README/.gitignore）。
3. 关联远程并推送（替换为你的仓库地址）：
```bash
git branch -M main
git remote add origin git@github.com:<your-org-or-user>/<your-repo>.git
git push -u origin main
```

## 部署到 Vercel
1. 在 Vercel 导入该 GitHub 仓库，Framework Preset 选 `Other`。
2. 在 Vercel 项目环境变量中配置：
   - `AI_API_KEY`（必填）
   - `AI_BASE_URL`（可选）
   - `AI_ENDPOINT`（可选，默认 `/azure/responses`）
   - `AI_MODEL`（可选）
3. 直接触发部署。

说明：
- 仓库已包含 `vercel.json`，会把所有路由交给 `server.js` 处理。
- Vercel 上 `POST /api/lexicon` 写入的是 `/tmp/standard-lexicon.csv`，仅实例级临时存储，不保证长期持久化。
