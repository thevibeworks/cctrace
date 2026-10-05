(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const zh = {
    skip: "跳转到内容",
    tour: "导览",
    docs: "文档",
    eyebrow: "看清编程 AGENT 的每一步。",
    headline: "看清整个<br><span>Agent 会话。</span>",
    intro: "跟随工作过程，找出上下文占用，<br>查看背后的每一次请求。",
    try: "探索示例会话",
    installLink: "追踪自己的会话",
    local: "开源。本地运行。无需 cctrace 账号。",
    contextScope: "上下文 / 逐次请求",
    estTokens: "估算 tokens",
    firstRequest: "首次请求",
    afterCompact: "压缩之后",
    play: "播放请求过程",
    pause: "暂停",
    openRequest: "打开请求",
    sampleNote: "真实捕获的会话。组成由 cctrace 计算。",
    worksWith: "支持",
    coverage: "各客户端支持范围 ↗",
    underHood: "看看内部",
    actualUI: "真实的 CCTRACE 界面",
    exploreTitle: "一个会话，三个入口。",
    interactive: "打开交互演示",
    sessions: "会话",
    sessionQuestion: "发生了什么？",
    context: "上下文",
    contextQuestion: "什么占满了窗口？",
    requests: "请求",
    requestQuestion: "到底发送了什么？",
    inspect: "打开，亲自查看。↗",
    screenshotNote: "真实捕获的会话 · 当前界面",
    beyond: "从证据到行动",
    insightTitle: "找出占用。<br>知道从哪下手。",
    insightIntro:
      "上下文很大只是起点。找出哪个文件被反复读取、哪些指令不断出现，以及哪些工具 schema 从未用到。",
    doctorSkill: "让 Agent 检查自己的上下文",
    doctorDesc:
      "这个上下文里有什么？找出重复内容、重复读取和未使用的工具 schema。",
    insightsDesc:
      "多次运行中，tokens 和估算费用花在哪了？查看缓存读写与最重的会话。",
    viewDesc:
      "重新打开保存的会话。回放过程，跟随子 Agent，查看每一步的原始请求。",
    yourTurn: "轮到你了",
    noService: "无需部署服务，无需注册账号。",
    installTitle: "还是那个 Agent。<br>现在看得见了。",
    installIntro:
      "通过 cctrace 启动 Agent。它会打开本地浏览器界面，并记录会话供之后查看。",
    requires: "需要",
    agentCLI: "以及你使用的 Agent CLI。",
    copy: "复制命令",
    copied: "已复制",
    copyFailed: "复制失败，请手动选择命令。",
    installComment: "# 安装一次",
    runComment: "# 启动 Claude Code 并追踪",
    otherClients: "或",
    privacy:
      "捕获的数据保存在本机。凭证字段会脱敏，对话内容则会保留。分享前请检查 trace。",
    captureScope: "捕获范围与隐私",
    installOptions: "安装方式",
    footer: "看清每一步工作。",
    sessionCaption:
      "按人的工作轮次阅读会话，跟随工具调用和子 Agent，再回放每一步。",
    contextCaption:
      "找出占用大的工具结果、重复指令和压缩边界。点击区块，查看背后的具体内容。",
    requestsCaption:
      "检查请求正文、响应、token 用量、缓存和延迟。每一个结论都有原始请求可查。",
    lightTheme: "切换到浅色主题",
    darkTheme: "切换到深色主题",
  };
  const en = Object.fromEntries(
    [...document.querySelectorAll("[data-i18n]")].map((node) => [
      node.dataset.i18n,
      node.innerHTML,
    ]),
  );
  Object.assign(en, {
    pause: "Pause",
    copied: "Copied",
    copyFailed: "Copy unavailable. Select the commands manually.",
    sessionCaption:
      "Read the session in human turns. Follow tool calls and subagent branches, then replay the work step by step.",
    contextCaption:
      "Find the heavy tool results, repeated instructions, and compaction boundaries. Click through to the content behind each block.",
    requestsCaption:
      "Inspect request bodies, responses, token usage, caching, and latency. Every conclusion has a request you can open.",
    lightTheme: "Switch to light theme",
    darkTheme: "Switch to dark theme",
  });
  let language = "en";
  let selectedView = "context";
  let selectedStep = 0;
  let playing = false;
  // The hero plays itself while it is in view, until the reader takes over.
  // Reduced motion keeps it still; the readout then opens on the peak step.
  let auto = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let inView = false;
  let timer;
  let copyTimer;
  const words = (key) =>
    (language === "zh" ? zh[key] : en[key]) || en[key] || key;
  const data = typeof CCTRACE_DEMO === "undefined" ? [] : CCTRACE_DEMO;
  // Open on the heaviest window of the session — the step worth looking at.
  if (data.length)
    selectedStep = data.reduce(
      (best, step, index) =>
        step.composition.est > data[best].composition.est ? index : best,
      0,
    );
  const wirePair =
    typeof CCTRACE_DEMO_PAIR === "undefined"
      ? data.length
        ? data[selectedStep].id
        : ""
      : CCTRACE_DEMO_PAIR;
  const categoryList =
    typeof CCTRACE_CATEGORIES === "undefined" ? [] : CCTRACE_CATEGORIES;
  const categories = categoryList.map((category) => [
    category.id,
    category.color,
  ]);
  const categoryZh = {
    system: "系统提示",
    tools: "工具 schema",
    user: "用户消息",
    inject: "注入上下文",
    assistant: "助手回复",
    toolResult: "工具结果",
  };
  const views = {
    session: {
      route: "#/session",
      alt: "cctrace Sessions view: a conversation, tool calls, a reviewer branch, and replay controls.",
    },
    context: {
      route: "#/context",
      alt: "cctrace Context view: request history, token composition, and a graph showing which tools fill the window.",
    },
    requests: {
      route: `#/p/${wirePair}`,
      alt: "cctrace Requests view: the selected API request with token, cache, timing, and payload details.",
    },
  };
  function themeLabel() {
    const label = words(
      document.documentElement.dataset.theme === "dark"
        ? "lightTheme"
        : "darkTheme",
    );
    $("#theme").setAttribute("aria-label", label);
    $("#theme").title = label;
  }
  $("#theme").addEventListener("click", () => {
    const theme =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("cctrace-site-theme", theme);
    } catch {}
    themeLabel();
  });
  function setView(name, animate = true) {
    selectedView = name;
    const view = views[name];
    for (const tab of document.querySelectorAll("[data-view]")) {
      const selected = tab.dataset.view === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    const image = $("#product-image");
    image.classList.remove("enter");
    image.src = `assets/${name}.png`;
    image.alt = view.alt;
    if (animate) {
      // Restart the small transition, including when cached images load instantly.
      void image.offsetWidth;
      image.classList.add("enter");
    }
    $("#product-panel").setAttribute("aria-labelledby", `tab-${name}`);
    $("#screenshot-link").href = $("#open-demo").href =
      `demo/sample.html${view.route}`;
    $("#screenshot-link").setAttribute(
      "aria-label",
      language === "zh"
        ? "在示例会话中探索此视图"
        : `Explore the ${name} view in the sample session`,
    );
    $("#view-caption").textContent = words(`${name}Caption`);
  }
  const tabs = [...document.querySelectorAll("[data-view]")];
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => setView(tab.dataset.view));
    tab.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft")
        next = (index + tabs.length - 1) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      tabs[next].focus();
      setView(tabs[next].dataset.view);
    });
  });
  function drawChart() {
    if (!data.length) {
      $("#play").disabled = true;
      return;
    }
    const max = Math.max(...data.map((step) => step.composition.est));
    const chart = $("#scope-chart");
    data.forEach((step, index) => {
      const button = document.createElement("button");
      button.className = "scope-bar";
      if (
        index &&
        step.composition.histLen < data[index - 1].composition.histLen
      )
        button.classList.add("cut");
      button.dataset.index = index;
      // Stack in the same bottom-to-top order as the application's context chart.
      for (const [category, color] of [...categories].reverse()) {
        const segment = document.createElement("span");
        segment.className = "scope-segment";
        segment.style.height = `${(step.composition.sums[category] / max) * 95}%`;
        segment.style.background = color;
        if (!step.composition.sums[category]) segment.hidden = true;
        button.append(segment);
      }
      button.addEventListener("click", () => {
        settle();
        selectStep(index);
      });
      button.addEventListener("keydown", (event) => {
        let next;
        if (event.key === "ArrowRight")
          next = Math.min(data.length - 1, index + 1);
        if (event.key === "ArrowLeft") next = Math.max(0, index - 1);
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = data.length - 1;
        if (next === undefined) return;
        event.preventDefault();
        settle();
        selectStep(next);
        chart.children[next].focus();
      });
      chart.append(button);
    });
  }
  function selectStep(index) {
    if (!data.length) return;
    selectedStep = Math.min(index, data.length - 1);
    const step = data[selectedStep];
    $("#token-count").textContent =
      step.composition.est.toLocaleString(language);
    $("#step-label").textContent =
      `${String(selectedStep + 1).padStart(2, "0")} / ${String(data.length).padStart(2, "0")}`;
    $("#step-wire").href = `demo/sample.html#/p/${step.id}`;
    // The heaviest category of this window, by name — whatever the wire said.
    const heaviest = categoryList.reduce(
      (best, category) =>
        (step.composition.sums[category.id] || 0) >
        (step.composition.sums[best.id] || 0)
          ? category
          : best,
      categoryList[0] || { id: "", label: "" },
    );
    const share = Math.round(
      ((step.composition.sums[heaviest.id] || 0) / step.composition.est) * 100,
    );
    const compacted =
      selectedStep > 0 &&
      step.composition.histLen < data[selectedStep - 1].composition.histLen;
    const message = compacted
      ? language === "zh"
        ? "压缩重写了上下文。打开请求，看看保留了什么。"
        : "Compaction rewrote the window. Open the request to see what survived."
      : selectedStep === 0
        ? language === "zh"
          ? "连第一条请求也带着指令和工具 schema。"
          : "Even the first request carries instructions and tool schemas."
        : language === "zh"
          ? `${categoryZh[heaviest.id] || heaviest.label}占这个窗口的 ${share}%。`
          : `${heaviest.label.charAt(0).toUpperCase()}${heaviest.label.slice(1)} occupies ${share}% of this window.`;
    $("#scope-insight").textContent = message;
    [...$("#scope-chart").children].forEach((button, i) => {
      const label =
        language === "zh"
          ? `请求 ${i + 1}：约 ${data[i].composition.est} tokens`
          : `Request ${i + 1}: approximately ${data[i].composition.est} tokens`;
      button.setAttribute("aria-label", label);
      button.title = label;
      button.setAttribute("aria-pressed", String(i === selectedStep));
      button.tabIndex = i === selectedStep ? 0 : -1;
    });
  }
  function playLabel() {
    $("#play").innerHTML =
      `<span aria-hidden="true">${playing ? "Ⅱ" : "▷"}</span> <span>${words(playing ? "pause" : "play")}</span>`;
    $("#play").setAttribute("aria-pressed", String(playing));
    // Announce manual selections, without a screen reader speaking every playback tick.
    $("#scope-insight").setAttribute("aria-live", playing ? "off" : "polite");
  }
  function stop() {
    clearTimeout(timer);
    playing = false;
    playLabel();
  }
  // The reader touched the chart: the hero stops playing itself for good.
  function settle() {
    auto = false;
    stop();
  }
  function tick() {
    if (selectedStep >= data.length - 1) {
      if (!auto) {
        stop();
        return;
      }
      // Hold the last window, then run the session again from the top.
      timer = setTimeout(() => {
        selectStep(0);
        timer = setTimeout(tick, 1100);
      }, 2600);
      return;
    }
    selectStep(selectedStep + 1);
    timer = setTimeout(tick, 1100);
  }
  function play(fromStart) {
    if (!data.length || playing) return;
    playing = true;
    if (fromStart || selectedStep >= data.length - 1) selectStep(0);
    playLabel();
    timer = setTimeout(tick, 1100);
  }
  function resume() {
    if (auto && !document.hidden && inView) play(false);
  }
  $("#play").addEventListener("click", () => {
    auto = false;
    if (playing) stop();
    else play(true);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else resume();
  });
  new IntersectionObserver((entries) => {
    inView = entries[0].isIntersecting;
    if (inView) resume();
    else stop();
  }).observe($(".scope"));
  window
    .matchMedia("(prefers-reduced-motion: reduce)")
    .addEventListener("change", (event) => {
      if (event.matches) settle();
    });
  function setLanguage(value) {
    language = value;
    document.documentElement.lang = value;
    document.querySelectorAll("[data-i18n]").forEach((node) => {
      node.innerHTML = words(node.dataset.i18n);
    });
    $("#language").textContent = value === "zh" ? "EN" : "中文";
    $("#language").setAttribute(
      "aria-label",
      value === "zh" ? "Switch to English" : "切换到中文",
    );
    document.title =
      value === "zh"
        ? "cctrace — 看清整个 Agent 会话"
        : "cctrace — understand the whole agent session";
    setView(selectedView, false);
    selectStep(selectedStep);
    playLabel();
    themeLabel();
    try {
      localStorage.setItem("cctrace-site-language", value);
    } catch {}
  }
  $("#language").addEventListener("click", () =>
    setLanguage(language === "en" ? "zh" : "en"),
  );
  $("#copy").addEventListener("click", async () => {
    clearTimeout(copyTimer);
    try {
      await navigator.clipboard.writeText(
        "npm install -g @thevibeworks/cctrace\ncctrace",
      );
      $("#copy").textContent = words("copied");
      $("#copy-status").textContent = words("copied");
    } catch {
      $("#copy-status").textContent = words("copyFailed");
      $("#copy").textContent = words("copyFailed");
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents($(".terminal pre"));
      selection.removeAllRanges();
      selection.addRange(range);
    }
    copyTimer = setTimeout(() => {
      $("#copy").textContent = words("copy");
    }, 3500);
  });
  drawChart();
  let initialLanguage = "en";
  try {
    if (localStorage.getItem("cctrace-site-language") === "zh")
      initialLanguage = "zh";
  } catch {}
  setLanguage(initialLanguage);
})();
