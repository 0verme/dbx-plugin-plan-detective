#!/usr/bin/env node

import readline from "node:readline";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { analyzeEstimatedPlan } from "../src/ai-tool/analyze-estimated-plan.js";
import { MAX_AI_TOOL_RAW_PLAN_CHARS } from "../src/ai-tool/dbx-agent-plan-input.js";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
export const PLUGIN_ID = manifest.id;
export const PLUGIN_VERSION = manifest.version;
export const ANALYZE_TOOL_NAME = "analyze_estimated_plan";
export const MAX_JSON_LINE_BYTES = 8 * 1024 * 1024;

const DBX_DATABASE_TYPES = Object.freeze([
  "postgres",
  "mysql",
  "sqlserver",
  "oracle",
  "oceanbase-oracle",
  "doris",
  "dameng",
  "questdb",
]);

const ANALYZE_TOOL = Object.freeze({
  name: ANALYZE_TOOL_NAME,
  description:
    "仅对已取得的完整 Estimated Plan（原始 JSON / text / XML）和明确的 DBX dbType / format 执行 Plan Detective 确定性分析；不获取计划、不执行 SQL、不连接数据库。不要传 SQL 或 Markdown 表格外壳代替 raw plan。当前 DBX Agent explain_query 尚无可交接的 structured raw-plan contract；若没有完整 raw plan 与来源元数据，请勿调用本工具。Estimated Plan 不是实际执行性能；不要把估算 cost 当成 elapsed time。",
  inputSchema: {
    type: "object",
    properties: {
      dbType: {
        type: "string",
        enum: DBX_DATABASE_TYPES,
        description: "来自 DBX Agent 当前连接上下文的明确 DBX database type；不可根据 plan 内容猜测。",
      },
      dbVersion: {
        type: "string",
        maxLength: 256,
        description: "DBX 已知的数据库版本（可选）；用于区分 OceanBase MySQL 等兼容模式。",
      },
      mode: {
        type: "string",
        enum: ["estimated"],
        description: "仅接受 Estimated Plan；Actual Plan / EXPLAIN ANALYZE 不支持。",
      },
      format: {
        type: "string",
        enum: ["json", "text", "xml"],
        description: "DBX explain result 中原始 plan 的序列化格式；不能根据 payload 猜测。",
      },
      rawPlan: {
        type: "string",
        maxLength: MAX_AI_TOOL_RAW_PLAN_CHARS,
        description: "完整原始 plan 内容；json 格式传 JSON 文本，text/xml 传原始文本。不能传 SQL、Markdown 表格外壳或截断内容。",
      },
      truncated: {
        type: "boolean",
        description: "来源明确报告的截断状态；仅 false 的完整计划可分析。",
      },
      warnings: {
        type: "array",
        items: { type: "string", maxLength: 128 },
        maxItems: 32,
        description: "来源报告的 plan warning codes；无法确认时不要伪造为空数组。",
      },
      sql: {
        type: "string",
        maxLength: 200000,
        description: "可选原始 SQL，仅作为本次分析的 provenance；不会执行，也不会在工具输出中回显。",
      },
    },
    required: ["dbType", "mode", "format", "rawPlan", "truncated", "warnings"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
});

/** Pure JSON-RPC dispatcher, exported for offline contract tests. */
export function handleRpcRequest(request) {
  if (!isObject(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return jsonRpcError(isObject(request) && isValidId(request.id) ? request.id : null, -32600, "Invalid Request");
  }

  const hasId = Object.hasOwn(request, "id");
  const id = hasId ? request.id : null;
  if (hasId && !isValidId(id)) return jsonRpcError(null, -32600, "Invalid Request");

  if (request.method === "plugin/initialize") {
    if (!hasId) return null;
    return handleInitialize(id, request.params);
  }
  if (request.method === "mcp/tools") {
    if (!hasId) return null;
    if (request.params !== undefined && !isObject(request.params)) {
      return jsonRpcError(id, -32602, "Invalid params");
    }
    return { jsonrpc: "2.0", id, result: { tools: [ANALYZE_TOOL] } };
  }
  if (request.method === "mcp/call") {
    if (!hasId) return null;
    return { jsonrpc: "2.0", id, result: handleToolCall(request.params) };
  }
  if (!hasId) return null;
  return jsonRpcError(id, -32601, "Method not found");
}

function handleInitialize(id, params) {
  if (!isObject(params) || !isObject(params.host) || !Array.isArray(params.host.protocolVersions) || !isObject(params.plugin)) {
    return jsonRpcError(id, -32602, "Invalid initialize params");
  }
  if (!params.host.protocolVersions.includes(1)) {
    return jsonRpcError(id, -32000, "No supported plugin protocol version");
  }
  if (params.plugin.id !== PLUGIN_ID || params.plugin.version !== PLUGIN_VERSION) {
    return jsonRpcError(id, -32000, "Backend identity does not match manifest");
  }
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: 1,
      capabilities: [],
      plugin: { id: PLUGIN_ID, version: PLUGIN_VERSION },
    },
  };
}

function handleToolCall(params) {
  if (!isObject(params) || params.tool !== ANALYZE_TOOL_NAME || !isObject(params.arguments)) {
    return toolError("INVALID_TOOL_CALL", "Expected analyze_estimated_plan and a JSON object of arguments.");
  }

  try {
    const { context } = analyzeEstimatedPlan(params.arguments);
    return {
      content: [{ type: "text", text: context }],
      isError: false,
    };
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "PLAN_ANALYSIS_FAILED";
    return toolError(code, safeErrorMessage(code));
  }
}

function toolError(code, message) {
  return {
    content: [{ type: "text", text: `Plan Detective 分析失败 [${code}]：${message}` }],
    isError: true,
  };
}

function safeErrorMessage(code) {
  const messages = {
    INVALID_AI_PLAN_INPUT: "工具输入不符合 contract；请提供明确且完整的 Estimated Plan 字段。",
    UNSUPPORTED_DB_TYPE: "数据库类型不受支持；不会根据 plan 内容推测数据库类型。",
    UNSUPPORTED_PLAN_MODE: "仅支持 Estimated Plan，不接受 Actual Plan。",
    UNSUPPORTED_PLAN_FORMAT: "计划格式不受支持。",
    PLAN_TRUNCATED: "计划已截断或带有截断 warning，不能安全分析。",
    PLAN_TOO_LARGE: `计划超过 ${MAX_AI_TOOL_RAW_PLAN_CHARS} 字符上限；插件不会静默截断。`,
    MALFORMED_PLAN_JSON: "JSON plan 格式错误或不是 object/array。",
    PARSER_NOT_AVAILABLE: "该数据库或计划格式没有可用的结构化分析器。",
    PLAN_PARSE_ERROR: "Plan Core 无法解析此计划；请确认数据库类型、格式和原始 payload。",
  };
  return messages[code] ?? "Plan Core 无法完成确定性分析；未返回部分或推测性结果。";
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidId(value) {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/** @param {NodeJS.ReadableStream} input @param {NodeJS.WritableStream} output */
export async function serve(input = process.stdin, output = process.stdout) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let response;
    if (Buffer.byteLength(line, "utf8") > MAX_JSON_LINE_BYTES) {
      response = jsonRpcError(null, -32700, "Message too large");
    } else {
      try {
        response = handleRpcRequest(JSON.parse(line));
      } catch {
        response = jsonRpcError(null, -32700, "Parse error");
      }
    }
    if (response !== null && response !== undefined) output.write(`${JSON.stringify(response)}\n`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  serve().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
