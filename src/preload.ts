import { init } from "./interceptor";

const config = {
  logDir: process.env.CCTRACE_LOG_DIR || ".cctrace",
  logName: process.env.CCTRACE_LOG_NAME,
  traceAll: process.env.CCTRACE_TRACE_ALL === "true",
  includeAllRequests: process.env.CCTRACE_INCLUDE_ALL === "true",
  openBrowser: process.env.CCTRACE_OPEN_BROWSER !== "false",
  serverPort: parseInt(process.env.CCTRACE_SERVER_PORT || "7890", 10),
  serverMode: process.env.CCTRACE_SERVER_MODE === "true",
};

init(config);
