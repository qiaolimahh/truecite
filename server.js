const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const config = require("./config");

const publicDir = path.join(__dirname, "public");
const serverPort = Number(process.env.PORT) || config.server?.port || 3000;
const REQUEST_TIMEOUT_MS = Math.max(
  Number(config.llm?.timeoutMs) || 0,
  90000
);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: "File not found." });
      return;
    }

    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

function isConfigReady() {
  const { baseUrl, apiKey, model } = config.llm || {};
  return Boolean(
    baseUrl &&
      apiKey &&
      model &&
      !baseUrl.includes("your-proxy-domain") &&
      apiKey !== "YOUR_API_KEY_HERE"
  );
}

function normalizeBaseUrl(rawUrl) {
  return String(rawUrl || "").replace(/\/+$/, "");
}

function buildChatCompletionsUrl(rawBaseUrl) {
  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  return /\/v\d+$/i.test(baseUrl)
    ? `${baseUrl}/chat/completions`
    : `${baseUrl}/v1/chat/completions`;
}

function toChineseVerdict(status) {
  switch (status) {
    case "real":
      return "真实";
    case "fabricated":
      return "虚构";
    case "suspicious":
    default:
      return "存疑";
  }
}

function extractJsonBlock(text) {
  const cleaned = String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }

    throw error;
  }
}

function buildSingleReferencePrompt(referenceText) {
  return [
    "你是一名严格的参考文献真实性核验助手。",
    "现在只核验一条参考文献。",
    "目标不是找排版小问题，而是判断这条参考文献是否像真实存在的论文、书籍或会议文章，以及主要元数据是否大体对应。",
    "请只返回纯 JSON，不要返回 markdown，不要写解释前言。",
    "返回格式必须是：",
    "{",
    '  "sourceText": "原始参考文献文本",',
    '  "parsed": {',
    '    "title": "",',
    '    "authors": [],',
    '    "year": "",',
    '    "journal": "",',
    '    "volume": "",',
    '    "issue": "",',
    '    "pages": "",',
    '    "publisher": "",',
    '    "doi": ""',
    "  },",
    '  "verification": {',
    '    "status": "real | suspicious | fabricated",',
    '    "confidence": 0,',
    '    "paperExists": true,',
    '    "metadataMatch": "high | partial | low | unknown",',
    '    "conclusion": "中文一句话结论",',
    '    "reason": "中文简短说明，重点解释这条参考文献为什么看起来真实、存疑或虚构",',
    '    "suggestedCitation": "如果能给出更规范的引用写法就填写，否则留空字符串"',
    "  }",
    "}",
    "规则：",
    "- 如果整条参考文献很像真实文献，status 用 real。",
    "- 如果文献可能存在，但作者、年份、期刊、DOI 等主要信息有明显冲突，status 用 suspicious。",
    "- 如果标题、作者、来源组合明显像虚构内容，status 用 fabricated。",
    "- 如果信息太少或信息模糊，也统一归为 suspicious。",
    "- confidence 使用 0 到 100 的整数。",
    "- conclusion 和 reason 都必须用中文。",
    "待核验参考文献：",
    referenceText
  ].join("\n");
}

async function callReferenceVerifier(referenceText) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(buildChatCompletionsUrl(config.llm.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.llm.apiKey}`
      },
      body: JSON.stringify({
        model: config.llm.model,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content:
              "You are a precise bibliographic verification engine. Return only valid JSON."
          },
          {
            role: "user",
            content: buildSingleReferencePrompt(referenceText)
          }
        ]
      }),
      signal: controller.signal
    });

    const raw = await response.text();
    const contentType = response.headers.get("content-type") || "";

    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.status} ${raw}`);
    }

    if (!contentType.includes("json")) {
      throw new Error(
        `LLM returned unexpected content type: ${contentType || "unknown"}`
      );
    }

    let parsedResponse;

    try {
      parsedResponse = JSON.parse(raw);
    } catch (error) {
      throw new Error(`LLM returned non-JSON response: ${raw}`);
    }

    const messageText =
      parsedResponse?.choices?.[0]?.message?.content ||
      parsedResponse?.output?.[0]?.content?.[0]?.text ||
      "";

    if (!messageText) {
      throw new Error("LLM returned an empty result.");
    }

    const result = extractJsonBlock(messageText);

    if (!result || typeof result !== "object") {
      throw new Error("LLM result could not be parsed into an object.");
    }

    return result;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeConfidence(rawValue) {
  const value = Number(rawValue);

  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value <= 1) {
    return Math.max(0, Math.min(100, Math.round(value * 100)));
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}

function sanitizeReferenceResult(result, fallbackSourceText) {
  const authors = Array.isArray(result?.parsed?.authors)
    ? result.parsed.authors
    : typeof result?.parsed?.authors === "string"
      ? result.parsed.authors
          .split(/[,;，；]/)
          .map((item) => item.trim())
          .filter(Boolean)
      : [];

  const metadataMatch = String(result?.verification?.metadataMatch || "unknown");
  const normalizedMetadataMatch = ["high", "partial", "low", "unknown"].includes(
    metadataMatch
  )
    ? metadataMatch
    : "unknown";

  const status = String(result?.verification?.status || "suspicious");
  const normalizedStatus = ["real", "suspicious", "fabricated"].includes(status)
    ? status
    : "suspicious";

  return {
    sourceText: result?.sourceText || fallbackSourceText || "",
    parsed: {
      title: result?.parsed?.title || "",
      authors,
      year: result?.parsed?.year || "",
      journal: result?.parsed?.journal || "",
      volume: result?.parsed?.volume || "",
      issue: result?.parsed?.issue || "",
      pages: result?.parsed?.pages || "",
      publisher: result?.parsed?.publisher || "",
      doi: result?.parsed?.doi || ""
    },
    verification: {
      status: normalizedStatus,
      finalVerdict: toChineseVerdict(normalizedStatus),
      confidence: normalizeConfidence(result?.verification?.confidence),
      paperExists:
        typeof result?.verification?.paperExists === "boolean"
          ? result.verification.paperExists
          : null,
      metadataMatch: normalizedMetadataMatch,
      conclusion: result?.verification?.conclusion || "",
      reason: result?.verification?.reason || "",
      suggestedCitation: result?.verification?.suggestedCitation || ""
    }
  };
}

async function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let rawData = "";

    req.on("data", (chunk) => {
      rawData += chunk;

      if (rawData.length > 2 * 1024 * 1024) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(rawData || "{}"));
      } catch (error) {
        reject(new Error("Request body is not valid JSON."));
      }
    });

    req.on("error", reject);
  });
}

async function handleVerifyReference(req, res) {
  if (!isConfigReady()) {
    sendJson(res, 400, {
      error:
        "请先在 config.js 中填写 llm.baseUrl、llm.apiKey 和 llm.model，然后再进行验证。"
    });
    return;
  }

  let body;

  try {
    body = await parseRequestBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const referenceText = String(body.referenceText || "").trim();

  if (!referenceText) {
    sendJson(res, 400, { error: "请输入单条参考文献内容。" });
    return;
  }

  try {
    const rawResult = await callReferenceVerifier(referenceText);
    const result = sanitizeReferenceResult(rawResult, referenceText);
    sendJson(res, 200, result);
  } catch (error) {
    console.error("Reference verification failed:", error);

    const isTimeout =
      error?.name === "AbortError" || /aborted|timeout/i.test(error.message);

    sendJson(res, 500, {
      error: isTimeout
        ? "这一条参考文献核验超时了，可以稍后重试。"
        : "这一条参考文献核验失败，请稍后重试。",
      detail: error.message
    });
  }
}

function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname =
    requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const safePath = path.normalize(path.join(publicDir, pathname));

  if (!safePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    sendFile(res, safePath);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/verify-reference") {
    await handleVerifyReference(req, res);
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed." });
});

server.listen(serverPort, () => {
  console.log(`Citation verifier is running at http://localhost:${serverPort}`);
});
