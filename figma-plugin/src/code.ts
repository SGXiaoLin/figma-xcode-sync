// code.ts — runs in Figma plugin sandbox
// Has access to Figma API but NO DOM, NO fetch

const COMPANION_PORT = 9876;

figma.showUI(__html__, { width: 380, height: 640, title: "Xcode Asset Sync" });

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// 资源名只能留字母数字和下划线；/、空格、中文等特殊字符统一换成 _，避免写入 .imageset 时变成非法路径。
function sanitizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function getPageName(): string {
  return sanitizeName(figma.currentPage.name) || "page";
}

function buildIconName(node: SceneNode, pageName: string): string {
  const cleanName = sanitizeName(node.name);
  return `${pageName}_ic_${cleanName || "icon"}`;
}

// Dev Mode 里同时跑两次 exportAsync，后面的导出会拿到空图。所有导出共用一把锁。
let exportChain: Promise<void> = Promise.resolve();
let exporting = false;

function withExportLock<T>(job: () => Promise<T>): Promise<T> {
  const run = exportChain.then(job, job);
  exportChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/// 粘贴进 Figma 的图片是带 Image 填充的矩形，不是 Frame 或矢量。
function hasImageFill(node: SceneNode): boolean {
  if (!("fills" in node)) return false;
  try {
    const fills = node.fills;
    if (fills === figma.mixed || !Array.isArray(fills)) return false;
    return fills.some((paint) => paint.type === "IMAGE" && paint.visible !== false);
  } catch (_err) {
    return false;
  }
}

// 设计稿里可能被当成一张图导出的图层。不含 FigJam 便签、连线和幻灯片。
const EXPORTABLE_TYPES = new Set<SceneNode["type"]>([
  "FRAME",
  "COMPONENT",
  "INSTANCE",
  "GROUP",
  "COMPONENT_SET",
  "SECTION",
  "TRANSFORM_GROUP",
  "VECTOR",
  "BOOLEAN_OPERATION",
  "RECTANGLE",
  "ELLIPSE",
  "STAR",
  "POLYGON",
  "LINE",
  "TEXT",
  "TEXT_PATH",
  "SLICE",
]);

function isExportableIcon(node: SceneNode): boolean {
  return EXPORTABLE_TYPES.has(node.type) || hasImageFill(node);
}

/// 选中哪个节点就整块 exportAsync，子图层合成一张图，不再往下拆 icon。
function resolveExportNodes(): { nodes: SceneNode[]; skipped: number } {
  let selected: readonly SceneNode[] = [];
  try {
    selected = figma.currentPage.selection;
  } catch (_err) {
    selected = [];
  }

  const nodes = selected.filter(isExportableIcon);
  return {
    nodes,
    skipped: Math.max(0, selected.length - nodes.length),
  };
}

/// 同一批里名称撞车时，从 _2 开始加后缀，避免后一张覆盖前一张。
function assignIconNames(nodes: SceneNode[], pageName: string): Map<string, string> {
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const node of nodes) {
    const base = buildIconName(node, pageName);
    let name = base;
    let suffix = 2;
    while (used.has(name)) {
      name = `${base}_${suffix++}`;
    }
    used.add(name);
    names.set(node.id, name);
  }
  return names;
}

// ─── Export single node at a given scale ──────────────────────────────────────

function normalizeBase64(value: string): string {
  const cleaned = value.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const remainder = cleaned.length % 4;
  return remainder === 0 ? cleaned : cleaned + "=".repeat(4 - remainder);
}

function isPNG(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

function isSVG(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 128);
  let start = 0;
  if (limit >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    start = 3;
  }
  for (let i = start; i < limit; i++) {
    const byte = bytes[i];
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    return byte === 0x3c;
  }
  return false;
}

// 沙箱里没有可靠的 btoa。手写 String.fromCharCode 再 btoa 会把 PNG 的 0x89 按 UTF-16/UTF-8 弄坏，
// Dev Mode 下还会经常拿到空 buffer。必须用 figma.base64Encode，并且拒绝空数据。
async function exportNodeAsBytes(
  node: SceneNode,
  format: "PNG" | "SVG",
  scale: number
): Promise<string> {
  const settings: ExportSettings =
    format === "PNG"
      ? { format: "PNG", constraint: { type: "SCALE", value: scale } }
      : { format: "SVG", svgOutlineText: false, svgIdAttribute: true };

  let bytes = await withExportLock(() => node.exportAsync(settings));
  if (bytes.length === 0) {
    bytes = await withExportLock(() => node.exportAsync(settings));
  }
  if (bytes.length === 0) {
    throw new Error(`"${node.name}" exported as empty ${format}.`);
  }
  if (format === "PNG" && !isPNG(bytes)) {
    throw new Error(`"${node.name}" export is not a PNG (${bytes.length} bytes).`);
  }
  if (format === "SVG" && !isSVG(bytes)) {
    throw new Error(`"${node.name}" export is not an SVG (${bytes.length} bytes).`);
  }
  const encoded = normalizeBase64(figma.base64Encode(bytes));
  const decoded = figma.base64Decode(encoded);
  if (decoded.length !== bytes.length || decoded[0] !== bytes[0]) {
    throw new Error(`"${node.name}" base64 round-trip failed.`);
  }
  return encoded;
}

const CHUNK_SIZE = 24000;

function postEncoded(
  meta: {
    name: string;
    module: string;
    format: "png" | "svg";
    renderingMode: "original" | "template";
    scaleKey: "1x" | "2x" | "3x" | null;
  },
  data: string
): string {
  const transferId = `${meta.name}:${meta.scaleKey ?? "svg"}:${Date.now()}:${Math.random()}`;
  const count = Math.max(1, Math.ceil(data.length / CHUNK_SIZE));
  for (let index = 0; index < count; index++) {
    figma.ui.postMessage({
      type: "export-chunk",
      transferId,
      index,
      count,
      chunk: data.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
      meta,
    });
  }
  return transferId;
}

// ─── Main export handler ──────────────────────────────────────────────────────

const SCALE_VALUES: { key: "1x" | "2x" | "3x"; value: 1 | 2 | 3 }[] = [
  { key: "1x", value: 1 },
  { key: "2x", value: 2 },
  { key: "3x", value: 3 },
];

async function exportSelectedIcons(
  format: "PNG" | "SVG",
  renderingMode: "original" | "template",
  scales: ScaleSelection
) {
  const nodes = resolveExportNodes().nodes;
  if (nodes.length === 0) {
    figma.ui.postMessage({ type: "error", message: "No icon frames selected." });
    return;
  }

  const activeScales = SCALE_VALUES.filter((s) => scales[s.key]);
  if (format === "PNG" && activeScales.length === 0) {
    figma.ui.postMessage({ type: "error", message: "Select at least one PNG scale." });
    return;
  }

  const pageName = getPageName();
  const iconNames = assignIconNames(nodes, pageName);
  figma.ui.postMessage({ type: "export-start", count: nodes.length });

  const transferIds: string[] = [];
  exporting = true;
  previewGeneration++;

  try {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const iconName = iconNames.get(node.id) || buildIconName(node, pageName);

    figma.ui.postMessage({
      type: "export-progress",
      current: i + 1,
      total: nodes.length,
      name: iconName,
    });

    try {
      // Dev Mode 只加载当前页。实例的主组件在别的页时，不先取一次导出会是空图。
      if (node.type === "INSTANCE") {
        try {
          await node.getMainComponentAsync();
        } catch (_err) {
          // 远程组件取不到时继续导出实例本身。
        }
      }

      if (format === "PNG") {
        // 串行导出。Dev Mode 里并行 exportAsync 会互相踩空 buffer。
        for (const s of activeScales) {
          const encoded = await exportNodeAsBytes(node, "PNG", s.value);
          transferIds.push(
            postEncoded(
              {
                name: iconName,
                module: pageName,
                format: "png",
                renderingMode,
                scaleKey: s.key,
              },
              encoded
            )
          );
        }
      } else {
        const svgData = await exportNodeAsBytes(node, "SVG", 1);
        transferIds.push(
          postEncoded(
            {
              name: iconName,
              module: pageName,
              format: "svg",
              renderingMode,
              scaleKey: null,
            },
            svgData
          )
        );
      }
    } catch (err) {
      figma.ui.postMessage({
        type: "export-item-error",
        name: iconName,
        error: String(err),
      });
    }
  }

    figma.ui.postMessage({ type: "export-ready", pageName, transferIds });
  } finally {
    exporting = false;
  }
}

// ─── Preview: list selected nodes before export ───────────────────────────────

function safeSize(node: SceneNode, key: "width" | "height"): number {
  try {
    const value = node[key];
    return typeof value === "number" ? value : 0;
  } catch (_err) {
    return 0;
  }
}

let lastSelectionKey: string | null = null;
let previewGeneration = 0;
let lastPreviewMessage: PluginMessage | null = null;
const lastThumbs: { id: string; thumb: string }[] = [];

async function sendSelectionPreview() {
  if (exporting) return;

  const resolved = resolveExportNodes();
  const nodes = resolved.nodes;
  const selectionKey = nodes.map((node) => node.id).join("|");
  if (selectionKey === lastSelectionKey) {
    if (lastPreviewMessage) figma.ui.postMessage(lastPreviewMessage);
    for (const thumb of lastThumbs) {
      figma.ui.postMessage({ type: "selection-thumb", id: thumb.id, thumb: thumb.thumb });
    }
    return;
  }
  lastSelectionKey = selectionKey;
  lastThumbs.length = 0;

  const generation = ++previewGeneration;
  const pageName = getPageName();
  const iconNames = assignIconNames(nodes, pageName);
  const preview = nodes.map((node) => ({
    id: node.id,
    name: node.name,
    iconName: iconNames.get(node.id) || buildIconName(node, pageName),
    width: safeSize(node, "width"),
    height: safeSize(node, "height"),
  }));
  lastPreviewMessage = {
    type: "selection-preview",
    items: preview,
    pageName,
    skipped: resolved.skipped,
  };
  figma.ui.postMessage(lastPreviewMessage);

  for (const node of nodes) {
    if (generation !== previewGeneration) return;
    try {
      const bytes = await withExportLock(() =>
        node.exportAsync({
          format: "PNG",
          constraint: { type: "WIDTH", value: 48 },
        })
      );
      if (generation !== previewGeneration || !isPNG(bytes)) continue;
      const thumb = `data:image/png;base64,${normalizeBase64(figma.base64Encode(bytes))}`;
      lastThumbs.push({ id: node.id, thumb });
      figma.ui.postMessage({ type: "selection-thumb", id: node.id, thumb });
    } catch (_err) {
      // 缩略图失败时仍保留名称列表。
    }
  }
}

// ─── Listen to Figma selection changes ────────────────────────────────────────

figma.on("selectionchange", sendSelectionPreview);
sendSelectionPreview(); // initial

// ─── Message handler from UI ──────────────────────────────────────────────────

figma.ui.onmessage = async (msg: PluginMessage) => {
  switch (msg.type) {
    case "export":
      await exportSelectedIcons(msg.format, msg.renderingMode, msg.scales);
      break;

    case "get-selection":
      sendSelectionPreview();
      break;

    case "get-folder": {
      // 插件 UI 是沙箱 iframe，localStorage 会直接抛错并把整页脚本打断。
      const folder = await figma.clientStorage.getAsync("destinationFolder");
      figma.ui.postMessage({
        type: "saved-folder",
        folder: typeof folder === "string" ? folder : "",
      });
      break;
    }

    case "set-folder":
      await figma.clientStorage.setAsync("destinationFolder", msg.folder);
      break;

    case "close":
      figma.closePlugin();
      break;
  }
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface IconPayload {
  name: string;
  module: string;
  format: "png" | "svg";
  renderingMode: "original" | "template";
  scales?: Partial<Record<"1x" | "2x" | "3x", string>>;
  data?: string;
}

type ScaleSelection = { "1x": boolean; "2x": boolean; "3x": boolean };

type PluginMessage =
  | {
      type: "export";
      format: "PNG" | "SVG";
      renderingMode: "original" | "template";
      scales: ScaleSelection;
    }
  | { type: "get-selection" }
  | { type: "get-folder" }
  | { type: "set-folder"; folder: string }
  | { type: "close" }
  | {
      type: "selection-preview";
      items: { id: string; name: string; iconName: string; width: number; height: number }[];
      pageName: string;
      skipped: number;
    };
