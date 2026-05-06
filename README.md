# 参考文献真实性验证网站

这是一个基于 GPT 的本地网站，用来：

- 从用户粘贴的任意文本中提取参考文献
- 识别作者、标题、年份、期刊、卷期、页码、出版社、DOI 等字段
- 判断每条参考文献最终属于真实、存疑还是虚构
- 标注哪些参考文献看起来真实，哪些存疑，哪些可能是虚构内容

## 1. 填写 GPT 配置

打开 [config.js](/c:/Users/Admin/Desktop/参考文献验证/config.js)，填写以下内容：

- `llm.baseUrl`: 你的中转站 OpenAI 兼容地址，例如 `https://xxx.com/v1`
- `llm.apiKey`: 你的 API Key
- `llm.model`: 你要使用的模型名，例如 `gpt-4.1-mini`

## 2. 启动方式

在当前目录执行：

```powershell
node .\server.js
```

启动后访问：

```text
http://localhost:3000
```

## 3. 说明

- 这个版本是零依赖实现，不需要安装任何 npm 包。
- 后端使用 OpenAI 兼容的 `/chat/completions` 接口。
- 如果你的中转站接口路径不同，可以在 [server.js](/c:/Users/Admin/Desktop/参考文献验证/server.js) 里调整请求地址。
- 结果属于 AI 核验意见，适合做初筛。对于高风险场景，建议再人工复核。
